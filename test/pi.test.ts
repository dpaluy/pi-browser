import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { browserExtension } from "../src/index.ts";
import { formatFind, resolveTarget } from "../src/targets.ts";
import type { browserSchema } from "../src/tool.ts";
import { view } from "../src/view.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp("/tmp/pibr-pi-");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function pi(t: TestContext, root: string, options: { mode?: "tui" | "rpc" | "print" | "json"; loadFromDisk?: boolean; key?: string } = {}) {
  const prompts: { question: string; options?: string[]; message?: string }[] = [];
  const answers: (string | boolean | undefined)[] = [];
  const notifications: string[] = [];
  const errors: unknown[] = [];
  const ui = {
    async select(question: string, options: string[]) {
      prompts.push({ question, options });
      assert(answers.length, `Unexpected prompt: ${question}`);
      const answer = answers.shift();
      assert(answer === undefined || (typeof answer === "string" && options.includes(answer)));
      return answer;
    },
    async confirm(question: string, message: string) {
      prompts.push({ question, message });
      const answer = answers.shift();
      assert(typeof answer === "boolean", `Unexpected confirmation: ${question}`);
      return answer;
    },
    notify(message: string) { notifications.push(message); },
  } as ExtensionUIContext;
  const settingsManager = SettingsManager.inMemory();
  const optionsForLoader = options.loadFromDisk
    ? { additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))] }
    : { extensionFactories: [browserExtension({ agentDir: root, browserDirs: [], typesafeKey: options.key ?? "", connectTimeoutMs: 1000 })] };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, ...optionsForLoader,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir: root, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root),
  });
  assert.deepEqual(extensionsResult.errors, []);
  const mode = options.mode ?? "tui";
  await session.bindExtensions({ mode, uiContext: ["tui", "rpc"].includes(mode) ? ui : undefined, onError: error => { errors.push(error); } });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    assert.deepEqual(errors, []);
    assert.deepEqual(answers, [], "Scripted prompt answers remaining");
  });
  const pathname = join(root, "browser", "sockets", `${session.sessionManager.getSessionId()}.sock`);
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    const tool = session.agent.state.tools.find(tool => tool.name === "browser");
    assert(tool);
    const prepared = tool.prepareArguments?.({ ...args, action }) ?? { ...args, action };
    const result = await tool.execute("call", prepared, t.signal);
    return result.content.map(item => item.type === "text" ? item.text : "").join("\n");
  };
  return { session, pathname, prompts, answers, notifications, call };
}

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
  allowed: string[];
  name: string;
}

type Response = { result: object } | { error: object };
async function browserPeer(t: TestContext, app: Awaited<ReturnType<typeof pi>>, dispatch: (request: Request) => Response) {
  await app.session.prompt("/browser"); // Install/start through the actual Pi slash command dispatcher.
  assert.match(app.notifications.at(-1) ?? "", /Extension folder: .*\nExtension ID: odhaeafpfooplfbcefglfcmlpbedofdo/);
  const socket = createConnection(app.pathname);
  const seen: Request[] = [];
  const reader = createInterface({ input: socket });
  t.after(() => { reader.close(); socket.destroy(); });
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    reader.on("line", line => {
      const request = JSON.parse(line);
      if (request.hello) {
        assert.equal(request.hello.protocol, 1);
        resolve();
      } else {
        seen.push(request);
        socket.write(`${JSON.stringify({ id: request.id, ...dispatch(request) })}\n`);
      }
    });
  });
  socket.write('{"hello":{"protocol":1,"extension":"0.1.0","browser":"Chrome/141.0"}}\n');
  await connected;
  return seen;
}

const helloHost = "example.test";
const question = (host: string) => `Let the agent use ${host} in the browser?`;
const choices = ["Allow once", "Allow for this session", "Always allow", "Deny"];
const error = (host: string, acted = false): Response => ({ error: { code: "needs-approval", host, acted, message: `Need ${host}` } });
const reply = (text = "ok"): Response => ({ result: { text } });

test("Pi 1.6 loads the extension file and registers browser only in TUI", async t => {
  const root = await fixture(t);
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    const app = await pi(t, root, { mode, loadFromDisk: true });
    assert.equal(app.session.getAllTools().some(tool => tool.name === "browser"), mode === "tui", mode);
    assert.equal(app.session.getActiveToolNames().includes("browser"), mode === "tui", mode);
  }
  for (const key of ["", "test-key"]) {
    const app = await pi(t, root, { key });
    const definition = app.session.getToolDefinition("browser");
    assert(definition);
    const props = (definition.parameters as ReturnType<typeof browserSchema>).properties;
    assert.equal(props.action.enum.includes("find"), Boolean(key));
    assert.equal(Object.hasOwn(props, "query"), Boolean(key));
    assert.equal(Object.hasOwn(props, "target"), Boolean(key));
    assert.equal(Object.hasOwn(props.fields.items.properties, "target"), Boolean(key));
  }
});

test("tool prompts at most once per host per call; once, session, always, and deny have distinct lifetimes", { timeout: 8000 }, async t => {
  const root = await fixture(t);
  const app = await pi(t, root);
  let force = false;
  let acted = false;
  let host = helloHost;
  const requests = await browserPeer(t, app, ({ allowed }) => force || !allowed.includes(host) ? error(host, acted) : reply());
  app.answers.push("Allow once");
  assert.equal(await app.call("read"), "ok");
  assert.deepEqual(requests.map(req => req.allowed), [[], [host]]);
  app.answers.push("Deny");
  await assert.rejects(app.call("read"), { message: `The user did not allow the browser on ${host}.` });
  assert.deepEqual(requests.at(-1)?.allowed, []);
  force = true;
  app.answers.push("Allow once");
  await assert.rejects(app.call("read"), { message: `Need ${host}` });
  assert.deepEqual(app.prompts.map(prompt => prompt.question), Array(3).fill(question(host)));
  assert.deepEqual(app.prompts[0].options, choices);
  force = false;
  app.answers.push("Allow for this session");
  await app.call("read");
  await app.call("read");
  assert.equal(app.prompts.length, 4);
  host = "other.test";
  app.answers.push("Always allow");
  assert.equal(await app.call("read"), "ok");
  const settings = join(root, "browser", "settings.json");
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")).alwaysAllow, [host]);
  const next = await pi(t, root);
  const nextRequests = await browserPeer(t, next, ({ allowed }) => allowed.includes(host) ? reply("new session") : error(host));
  assert.equal(await next.call("read"), "new session");
  assert.deepEqual(nextRequests[0].allowed, [host]);
  assert.deepEqual(next.prompts, []);
  host = "redirected.test";
  acted = true;
  app.answers.push("Allow for this session");
  const before = requests.length;
  await assert.rejects(app.call("back"), /already ran and reached redirected\.test; it was not repeated/);
  assert.equal(requests.length, before + 1);
  assert.equal(await app.call("read"), "ok");
});

test("tool drops unused/default params and validates eval through the real request boundary", { timeout: 8000 }, async t => {
  const root = await fixture(t);
  const app = await pi(t, root, { key: "test-key" });
  const requests = await browserPeer(t, app, ({ method }) => reply(method));
  assert.equal(await app.call("read", { tabId: 0, code: "ignored", offset: 0, url: "ignored", paths: [], text: "" }), "read");
  assert.deepEqual(requests.at(-1)?.params, {});
  await app.call("navigate", { url: "https://example.test", newTab: false, ref: 12 });
  assert.deepEqual(requests.at(-1)?.params, { url: "https://example.test", newTab: false });
  await app.call("click", { ref: 3, target: "ref wins even with Jev", point: [], clickCount: 0 });
  assert.deepEqual(requests.at(-1)?.params, { ref: 3 });
  await app.call("fill", { fields: [{ ref: 7, target: "ref wins", value: "" }] });
  assert.deepEqual(requests.at(-1)?.params, { fields: [{ ref: 7, value: "" }] });
  await app.call("wait", { text: "", timeout: 0, gone: false, values: [] });
  assert.deepEqual(requests.at(-1)?.params, { gone: false });
  const count = requests.length;
  for (const [code, message] of [
    ["a\n".repeat(20) + "a", /limited to 20 lines/],
    ["x".repeat(1501), /1,500 characters/],
    ["a;\n  \n\t\nb;", /two blank lines/],
    ["a\u200Db", /invisible or control/],
    ["a\u001bb", /invisible or control/],
  ] as const) await assert.rejects(app.call("eval", { code }), message);
  app.answers.push("Cancel");
  await assert.rejects(app.call("eval", { code: "1 + 1" }), /did not allow browser eval/);
  assert.equal(requests.length, count);
  const code = "let x = 3;\n\tx + 5;";
  app.answers.push("Run all 2 lines");
  assert.equal(await app.call("eval", { code }), "eval");
  assert.deepEqual(requests.at(-1)?.params, { code });
  assert.equal(app.prompts.at(-1)?.question, `Run this browser code?\n${code}`);
  app.answers.push("Turn off eval confirmation");
  await app.session.prompt("/browser settings");
  const limit = "x;\n".repeat(19) + "x".repeat(1500 - 57);
  assert.equal(await app.call("eval", { code: limit }), "eval");
});

test("upload checks local files before asking and pins consent to the actual destination", { timeout: 8000 }, async t => {
  const root = await fixture(t);
  const app = await pi(t, root);
  const paths = [join(root, "memo.txt"), join(root, "report.txt")];
  await Promise.all(paths.map(path => writeFile(path, "fixture")));
  await assert.rejects(app.call("upload", { ref: 10, paths: ["missing"] }), /Not a file: .*\/missing/);
  await assert.rejects(app.call("upload", { ref: 10, paths: ["."] }), /Not a file: /);
  assert.equal(app.prompts.length, 0);
  await assert.rejects(access(app.pathname), { code: "ENOENT" });
  let destination = "upload.test";
  const requests = await browserPeer(t, app, request => {
    if (request.method === "tabs") return { result: { tabs: [{ id: 10, current: true, title: "Upload", url: "https://upload.test/form" }], others: 0 } };
    return request.allowed.includes(destination) ? reply("Uploaded") : error(destination);
  });
  app.answers.push(false);
  await assert.rejects(app.call("upload", { ref: 1, paths: ["memo.txt"] }), /did not allow the browser upload/);
  assert.deepEqual(requests.map(req => req.method), ["tabs"]);
  app.answers.push(true, "Allow for this session");
  assert.equal(await app.call("upload", { ref: 1, paths: ["memo.txt", paths[1]] }), "Uploaded");
  assert.deepEqual(requests.at(-1)?.params, { ref: 1, paths, tabId: 10 });
  assert.match(app.prompts[1].question, /Let the agent attach .* to a page on upload\.test\?/);
  assert.equal(app.prompts[1].message, paths.join("\n"));
  destination = "frame.test";
  app.answers.push(true, false);
  await assert.rejects(app.call("upload", { ref: 1, paths }), /did not allow the browser upload on frame\.test/);
  assert.deepEqual(requests.at(-1)?.allowed, ["upload.test"]);
  assert.match(app.prompts.at(-1)?.question ?? "", /to a page on frame\.test\?/);
});

test("view resumes after the last shown raw line in full and interactive pages", () => {
  const header = "Tab 123: Page title <https://example.com>";
  const snapshot = [header, ...Array.from({ length: DEFAULT_MAX_LINES + 2 }, (_, i) => `line ${i + 1}`)].join("\n");
  const first = view(snapshot);
  assert.match(first, new RegExp(`line ${DEFAULT_MAX_LINES - 1}\\n\\n\\[Output truncated; continue with offset ${DEFAULT_MAX_LINES}\\.\\]$`));
  assert.equal(view(snapshot, DEFAULT_MAX_LINES), `line ${DEFAULT_MAX_LINES}\nline ${DEFAULT_MAX_LINES + 1}\nline ${DEFAULT_MAX_LINES + 2}`);
  const interactive = [header, ...Array.from({ length: DEFAULT_MAX_LINES }, (_, i) => `heading "${i}"\n[${i + 1}] button "${i}"`)].join("\n");
  const firstFiltered = view(interactive, 0, true);
  assert.match(firstFiltered, new RegExp(`continue with offset ${2 * DEFAULT_MAX_LINES - 1}\\.`));
  assert.doesNotMatch(firstFiltered, /heading/);
  assert.equal(view(interactive, 2 * DEFAULT_MAX_LINES - 1, true), `[${DEFAULT_MAX_LINES}] button "${DEFAULT_MAX_LINES - 1}"`);
  assert.equal(view(`${header}\nheading "Welcome"\n  [41] link "Sign in"\n`, 0, true), `${header}\n  [41] link "Sign in"`);
  assert.match(view(`${header}\n${"ä".repeat(DEFAULT_MAX_BYTES / 2)}\nend`), /continue with offset 1/);
  assert.match(view(`${header}\n${"ä".repeat(DEFAULT_MAX_BYTES / 2)}\nend`, 1), /continue with offset 2/);
  assert.throws(() => view(`${header}\n`, 1), /past the end of the snapshot/);
});

test("Jev output names match strength and candidates, resolving only clear ref lines", () => {
  const lines = ["Tab 1: Sample", "heading Welcome", "  [41] link Sign in", "[52] textbox Email", "[8] button Submit", "[9] link Help", "[10] link Contact", "[11] link Other"];
  const hit = (line: number, score: number) => ({ line, score, probability: score, ambiguous: 0 });
  assert.equal(formatFind(lines, "welcome", { exists: 0.88, ambiguous: 0, hits: [hit(1, 0.8), ...[2, 3, 4, 5, 6, 7].map(line => hit(line, 0.03))] }),
    `"welcome": found on this page (match 88%).\nline 2 (80%): heading Welcome\nline 3 (3%):   [41] link Sign in\nline 4 (3%): [52] textbox Email\nline 5 (3%): [8] button Submit\nline 6 (3%): [9] link Help`);
  assert.deepEqual(resolveTarget(lines, "sign in", { exists: 0.92, ambiguous: 0.02, hits: [hit(2, 0.87), hit(3, 0.10)] }),
    { ref: 41, note: `Matched "sign in" → [41] link Sign in (87%)` });
  assert.throws(() => resolveTarget(lines, "link", { exists: 0.91, ambiguous: 0.73, hits: [hit(2, 0.5), hit(5, 0.38), hit(6, 0.13), hit(7, 0.05)] }),
    { message: `"link" fits more than one element (73% likely), so nothing was done.\nline 3 (50%):   [41] link Sign in\nline 6 (38%): [9] link Help\nline 7 (13%): [10] link Contact` });
  assert.throws(() => resolveTarget(lines, "logout", { exists: 0.12, ambiguous: 0.01, hits: [hit(2, 0.1)] }),
    { message: `No element clearly matches "logout" (match 12%), so nothing was done.\nline 3 (10%):   [41] link Sign in` });
});

test("fill resolves its targets together and sends nothing if any target is ambiguous", { timeout: 8000 }, async t => {
  const root = await fixture(t);
  const app = await pi(t, root, { key: "test-key" });
  const snapshot = 'Tab 42: Sample <https://example.test/form>\n[11] textbox "Email"\n[12] textbox "Name"';
  const requests = await browserPeer(t, app, ({ method }) => method === "read" ? reply(snapshot) : reply("Filled"));
  const jevRequests: Record<string, unknown>[] = [];
  let ambiguous = false;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(options.body));
    jevRequests.push(body.questions);
    return Response.json({ answers: {
      exists0: { noul: 0.95 }, ambiguous0: { noul: 0 }, where0: { probabilities: { L1: 1 } },
      exists1: { noul: 0.9 }, ambiguous1: { noul: ambiguous ? 0.8 : 0 }, where1: { probabilities: { L2: 1 } },
    } });
  });
  const fields = [{ target: "email", value: "person@example.test" }, { target: "name", value: "A Person" }];
  assert.equal(await app.call("fill", { fields }), 'Matched "email" → [11] textbox "Email" (95%)\nMatched "name" → [12] textbox "Name" (90%)\nFilled');
  assert.deepEqual(requests.map(req => req.method), ["read", "fill"]);
  assert.deepEqual(requests[1].params, { tabId: 42, fields: [{ ref: 11, value: fields[0].value }, { ref: 12, value: fields[1].value }] });
  assert.equal(jevRequests.length, 1);
  assert.deepEqual(Object.keys(jevRequests[0]), ["where0", "exists0", "ambiguous0", "where1", "exists1", "ambiguous1"]);
  ambiguous = true;
  await assert.rejects(app.call("fill", { fields }), /"name" fits more than one element \(80% likely\), so nothing was done/);
  assert.deepEqual(requests.map(req => req.method), ["read", "fill", "read"]);
});
