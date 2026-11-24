import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { escapeRE, tabId } from "./assertions.ts";
import { waitUntil } from "./harness.ts";
import { setup } from "./pi.ts";
import { SessionServer } from "../../src/server.ts";


const choices = ["Allow once", "Allow for this session", "Always allow", "Deny"];
const question = (host: string) => `Let the agent use ${host} in the browser?`;
const denied = (host: string) => `The user did not allow the browser on ${host}.`;

test("navigate creates a background tab in the named group; tabs counts and refuses outside tabs", async t => {
  const h = await setup(t);
  const pi = await h.session("Field notes");
  const outside = await h.worker<{ id: number; windowId: number }>("chrome.tabs.query({active:true}).then(tabs=>tabs[0])");
  await h.worker(`(() => {
    globalThis.fixtureActivations = [];
    chrome.tabs.onActivated.addListener(({tabId}) => globalThis.fixtureActivations.push(tabId));
  })()`);
  const url = h.url();
  const id = tabId((await pi.call("navigate", { url }, ["Allow for this session"])).text, "Pi controls", url);
  const group = await h.worker<{ title: string; active: boolean; windowId: number }>(`(async () => {
    const tab = await chrome.tabs.get(${id});
    return { title: (await chrome.tabGroups.get(tab.groupId)).title, active: tab.active, windowId: tab.windowId };
  })()`);
  assert.deepEqual(group, { title: "pi · Field notes", active: false, windowId: outside.windowId });
  assert.equal(await h.worker(`chrome.tabs.get(${outside.id}).then(t=>t.active)`), true);
  assert(!((await h.worker<number[]>("globalThis.fixtureActivations")).includes(id)), "The new tab was briefly activated");
  const others = await h.worker<number>(`chrome.tabs.query({}).then(tabs=>tabs.filter(t=>t.id!==${id}).length)`);
  const { text } = await pi.call("tabs");
  assert.match(text, new RegExp(`^Tab ${id}: Pi controls <${escapeRE(url)}> \\(current\\)$`, "m"));
  assert(text.trimEnd().endsWith(`${others} other tabs are not in your group.`), text);
  assert.equal((await pi.call("read", { tabId: outside.id })).text, `Tab ${outside.id} is not in your group.`);
});

test("allow once expires; denial does not navigate; a session grant covers later calls", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  assert.equal((await pi.call("navigate", { url }, ["Deny"])).text, denied("controls.test"));
  assert(!h.requests.some(req => req.host === "controls.test"), "Denied navigate reached the fixture");
  const id = tabId((await pi.call("navigate", { url }, ["Allow once"])).text, "Pi controls", url);
  const own = (await pi.call("tabs")).text;
  assert.match(own, new RegExp(`^Tab ${id}: controls\\.test$`, "m"));
  assert.doesNotMatch(own, /Pi controls|controls\.html/);
  assert.equal((await pi.call("read", {}, ["Deny"])).text, denied("controls.test"));
  assert.match((await pi.call("read", {}, ["Allow for this session"])).text, /Create your account/);
  assert.match((await pi.call("read")).text, /Create your account/);
  assert.deepEqual(pi.prompts, Array.from({ length: 4 }, () => ({ title: question("controls.test"), options: choices })));
});

test("always approval persists to settings and applies to a new Pi session", async t => {
  const h = await setup(t);
  const pi = await h.session("Approved first");
  const url = h.url();
  tabId((await pi.call("navigate", { url }, ["Always allow"])).text, "Pi controls", url);
  const settings = JSON.parse(await readFile(join(h.agentDir, "browser", "settings.json"), "utf8"));
  assert.deepEqual(settings.alwaysAllow, ["controls.test"]);
  await pi.shutdown();
  const next = await h.session("Approved second");
  tabId((await next.call("navigate", { url })).text, "Pi controls", url);
  assert.deepEqual(next.prompts, []);
});

test("a redirect to a different host prompts again and does not leak the denied page", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/redirect", "entry.test");
  const result = await pi.call("navigate", { url }, ["Allow once", "Deny"]);
  assert.equal(result.text, denied("private.test"));
  assert.deepEqual(result.images, []);
  assert.deepEqual(pi.prompts.map(p => p.title), [question("entry.test"), question("private.test")]);
  assert.equal(await h.page(h.url("/private.html", "private.test"), "document.title"), "Confidential fixture title");
  const list = (await pi.call("tabs")).text;
  assert.match(list, /^Tab \d+: private\.test$/m);
  assert.doesNotMatch(list, /private\.html|Confidential/);
});

test("sessions own distinct groups and grants; shutdown ends the group without closing its tabs", async t => {
  const h = await setup(t);
  const a = await h.session("Research");
  const b = await h.session("Review");
  const aUrl = h.url();
  const bUrl = h.url("/interaction.html");
  const aId = tabId((await a.call("navigate", { url: aUrl }, ["Allow for this session"])).text, "Pi controls", aUrl);
  const bId = tabId((await b.call("navigate", { url: bUrl }, ["Allow for this session"])).text, "Pointer workshop", bUrl);
  const groupFor = (id: number) => h.worker<{ id: number; title: string }>(`chrome.tabs.get(${id}).then(t=>chrome.tabGroups.get(t.groupId))`);
  const [aGroup, bGroup] = await Promise.all([groupFor(aId), groupFor(bId)]);
  assert.notEqual(aGroup.id, bGroup.id);
  assert.equal(aGroup.title, "pi · Research");
  assert.equal(bGroup.title, "pi · Review");
  assert.equal((await a.call("read", { tabId: bId })).text, `Tab ${bId} is not in your group.`);
  assert.equal((await b.call("close", { tabId: aId })).text, `Tab ${aId} is not in your group.`);

  const socket = join(h.socketsDir, `${a.id}.sock`);
  assert((await lstat(socket)).isSocket());
  await a.shutdown();
  await assert.rejects(lstat(socket), { code: "ENOENT" });
  await waitUntil("ended group title", async () => (await groupFor(aId)).title === "pi · Research (ended)" ? true : undefined);
  assert.equal((await groupFor(aId)).id, aGroup.id);
  assert.equal(await h.page(aUrl, "document.title"), "Pi controls");
  assert.match((await b.call("read")).text, /Pointer workshop/);
});

test("a same-session socket replacement cannot receive an in-flight response", async t => {
  const h = await setup(t);
  const session = "reconnecting";
  const open = async () => {
    const server = await SessionServer.open(h.socketsDir, session, () => "Reconnecting");
    t.after(() => server.close());
    await server.connect(10_000);
    return server;
  };
  const a = await open();
  // Prime the tab, then open a fresh peer so the delayed eval and the later status both have id 1.
  const url = h.url();
  const allowed = ["controls.test"];
  assert.match((await a.request("navigate", { url }, allowed, 10_000)).text!, /Pi controls/);
  await a.close();
  const b = await open();
  const pending = assert.rejects(b.request("eval", {
    code: 'await new Promise(resolve => { globalThis.finishFixtureEval = () => resolve("old response"); })',
  }, allowed, 15_000), /disconnected/);
  try {
    await waitUntil("eval started", async () => await h.page(url, "typeof finishFixtureEval") === "function" ? true : undefined);
    await b.close();
    await pending;
    const c = await open();
    const status = c.request("status", {}, [], 10_000);
    await h.page(url, "finishFixtureEval()");
    assert.match((await status).text!, /^Pi Browser .* sessions$/);
  } finally {
    await b.close();
    await pending;
  }
});
