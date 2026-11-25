import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { HOST_NAME } from "../../src/install.ts";
import { tabId } from "./assertions.ts";
import { extensionId, waitUntil } from "./harness.ts";
import { setup } from "./pi.ts";

function toolbarChecks(h: Awaited<ReturnType<typeof setup>>) {
  const toolbar = () => h.worker<{ icon: string; title: string; badge: string } | undefined>(`(async () => {
    const icon = globalThis.piBrowserIconState;
    if (icon) return { icon, title: await chrome.action.getTitle({}), badge: await chrome.action.getBadgeText({}) };
  })()`);
  const expectToolbar = async (icon: string, title: RegExp, badge: string) => {
    const state = await waitUntil(`${icon} toolbar`, async () => {
      const state = await toolbar();
      return state?.icon === icon && title.test(state.title) && state.badge === badge ? state : undefined;
    });
    assert.equal(state.icon, icon);
    assert.match(state.title, title);
    assert.equal(state.badge, badge);
  };
  return expectToolbar;
}

const sessionsTitle = /^Pi Browser: 1 session — click to turn off$/;

test("toolbar shows the native connection, session count, and in-flight actions", async t => {
  const h = await setup(t, { alwaysAllow: ["controls.test"] }, async profileDir => {
    // Record the PID of this profile's real relay without changing its native messaging streams.
    const launcher = join(profileDir, "NativeMessagingHosts", `${HOST_NAME}.sh`);
    const original = await readFile(launcher, "utf8");
    await writeFile(launcher, original.replace("\n", () => '\nprintf "%s\\n" "$$" > "$0.pid"\n'));
  });
  const expectToolbar = toolbarChecks(h);
  await expectToolbar("ready", /^Pi Browser: connected — click to turn off$/, "");
  const pi = await h.session();
  await pi.command("browser", "");
  await expectToolbar("active", sessionsTitle, "1");

  const url = h.url();
  tabId((await pi.call("navigate", { url })).text, "Pi controls", url);
  await expectToolbar("active", sessionsTitle, "1");
  const marker = "Toolbar fixture finished";
  const waiting = pi.call("wait", { text: marker });
  try {
    await expectToolbar("working", sessionsTitle, "1");
  } finally {
    await h.page(url, `void document.body.append(${JSON.stringify(marker)})`);
  }
  assert.equal((await waiting).text, "Wait condition met.");
  await expectToolbar("active", sessionsTitle, "1");

  const nativeHost = join(h.profileDir, "NativeMessagingHosts", HOST_NAME);
  const pid = Number(await readFile(`${nativeHost}.sh.pid`, "utf8"));
  assert(Number.isSafeInteger(pid) && pid > 1);
  // Hide the temporary profile's manifest so retries cannot reconnect before the off assertion.
  await rename(`${nativeHost}.json`, `${nativeHost}.json.disabled`);
  process.kill(pid, "SIGTERM");
  await expectToolbar("off", /^Pi Browser: (Native host has exited|Specified native messaging host not found)\. — click to turn off$/, "");
});

test("toolbar toggles control, detaches the debugger, and remembers off across a worker restart", async t => {
  const h = await setup(t, { alwaysAllow: ["controls.test"] });
  const pi = await h.session();
  const expectToolbar = toolbarChecks(h);
  // Chromium's worker-side event dispatch invokes the actual registered click handler.
  const click = () => h.worker("void chrome.action.onClicked.dispatch()");
  const offTitle = /^Pi Browser: off — click to turn on$/;
  const offMessage = "Pi Browser is turned off in the browser. Click its toolbar icon to turn it on.";
  const url = h.url();
  const id = tabId((await pi.call("navigate", { url })).text, "Pi controls", url);
  const attached = () => h.worker<boolean>(`chrome.debugger.getTargets().then(ts => ts.find(t => t.tabId === ${id})?.attached)`);
  assert.equal(await attached(), true);
  await expectToolbar("active", sessionsTitle, "1");

  const waiting = pi.call("wait", { text: "Never shown by this fixture", timeout: 15_000 });
  await expectToolbar("working", sessionsTitle, "1");
  await click();
  await expectToolbar("disabled", offTitle, "");
  // The in-flight action is interrupted before issuing the next Pi tool call.
  assert.equal((await waiting).text, offMessage);
  await waitUntil("debugger detached from group tab", async () => await attached() === false ? true : undefined);
  const start = performance.now();
  assert.equal((await pi.call("read")).text, offMessage);
  assert(performance.now() - start < 5_000, "Off request did not fail immediately");
  assert.match((await pi.call("status")).text, /^Pi Browser .* · 1 session$/);
  await pi.command("browser", "");
  assert(pi.notifications.at(-1)?.message.split("\n")[0].endsWith(offMessage));

  await h.withPage("about:blank", async send => {
    const scopeURL = `chrome-extension://${extensionId}/`;
    const workerId = async () => {
      const { targetInfos } = await send<{ targetInfos: { type: string; url: string; targetId: string }[] }>("Target.getTargets");
      return targetInfos.find(target => target.type === "service_worker" && target.url.startsWith(scopeURL))?.targetId;
    };
    const before = await workerId();
    assert(before);
    await send("ServiceWorker.enable");
    await send("ServiceWorker.stopAllWorkers");
    await waitUntil("worker stopped", async () => (await workerId()) !== before ? true : undefined);
    await send("ServiceWorker.startWorker", { scopeURL });
    const after = await waitUntil("new worker", workerId);
    assert.notEqual(after, before);
  });
  await expectToolbar("disabled", offTitle, "");
  await pi.command("browser", "");
  assert(pi.notifications.at(-1)?.message.split("\n")[0].endsWith(offMessage));
  assert.equal((await pi.call("read")).text, offMessage);
  assert.equal(await attached(), false);

  await click();
  await expectToolbar("active", sessionsTitle, "1");
  assert.match((await pi.call("read")).text, /Create your account/);
  assert.equal(await attached(), true);
  await pi.command("browser", "");
  assert.match(pi.notifications.at(-1)!.message.split("\n")[0], /^Connected to .+ \(extension \d+\.\d+\.\d+\)\.$/);
});

test("turning on reconnects at once and clears a debugger the user canceled", async t => {
  const h = await setup(t, { alwaysAllow: ["controls.test"] });
  const expectToolbar = toolbarChecks(h);
  const click = () => h.worker("void chrome.action.onClicked.dispatch()");
  const pi = await h.session();
  const url = h.url();
  const id = tabId((await pi.call("navigate", { url })).text, "Pi controls", url);

  // The user clicks Cancel on the "started debugging" bar: Chrome detaches and reports canceled_by_user.
  await h.worker(`chrome.debugger.detach({ tabId: ${id} }).then(() => chrome.debugger.onDetach.dispatch({ tabId: ${id} }, "canceled_by_user"))`);
  const canceled = /The debugger was canceled by the user\. Turn Pi Browser off and on again/;
  assert.match((await pi.call("read")).text, canceled);
  await click();
  await expectToolbar("disabled", /^Pi Browser: off — click to turn on$/, "");
  await click();
  await expectToolbar("active", sessionsTitle, "1");
  assert.match((await pi.call("read")).text, /Create your account/);

  // Disconnect the relay and let the retry backoff grow past 8 s before turning off and on again.
  const nativeHost = join(h.profileDir, "NativeMessagingHosts", HOST_NAME);
  await rename(`${nativeHost}.json`, `${nativeHost}.json.disabled`);
  // Pi rewrites the launcher when its session starts, so find this profile's relay by its sockets folder.
  execFileSync("pkill", ["-TERM", "-f", join(h.agentDir, "browser", "sockets")]);
  await expectToolbar("off", /^Pi Browser: (Native host has exited|Specified native messaging host not found)\./, "");
  await new Promise(resolve => setTimeout(resolve, 9_000));
  await click();
  await expectToolbar("disabled", /^Pi Browser: off — click to turn on$/, "");
  await rename(`${nativeHost}.json.disabled`, `${nativeHost}.json`);
  const start = performance.now();
  await click();
  await expectToolbar("active", sessionsTitle, "1");
  assert(performance.now() - start < 3_000, `Turning on took ${Math.round(performance.now() - start)} ms to reconnect`);
  assert.match((await pi.call("read")).text, /Create your account/);
});
