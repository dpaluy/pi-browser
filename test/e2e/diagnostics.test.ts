import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeRE, ref, tabId } from "./assertions.ts";
import { setup } from "./pi.ts";

const allow = ["Allow for this session"];

test("console returns the page log and exception; network returns metadata without headers or body", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/diagnostics.html");
  tabId((await pi.call("navigate", { url }, allow)).text, "Diagnostics station", url);
  const fetchParcel = ref((await pi.call("read")).text, "button", "Fetch parcel");
  await pi.call("console"); // Enables collection before the fixture generates any events.
  await pi.call("click", { ref: fetchParcel });
  await pi.call("wait", { text: "parcel received" });
  assert.equal(await h.page(url, "document.querySelector('#done').value"), "parcel received");
  const consoleOutput = (await pi.call("console")).text;
  assert.match(consoleOutput, /parcel requested/);
  assert.match(consoleOutput, /parcel fixture exception/);
  const network = (await pi.call("network")).text;
  assert.match(network, new RegExp(`^GET 200 fetch ${escapeRE(h.url("/api/parcel"))}$`, "im"));
  assert.doesNotMatch(network, /x-fixture|request-header-secret|response-header-secret|response-body-secret/i);
});

test("eval with confirmation shows the code and executes only after user approval", async t => {
  const h = await setup(t, { confirmEval: true });
  const pi = await h.session();
  const url = h.url();
  tabId((await pi.call("navigate", { url }, allow)).text, "Pi controls", url);
  const code = "globalThis.fixtureEvaluation = 73;";
  const denied = await pi.call("eval", { code }, ["Cancel"]);
  assert.doesNotMatch(denied.text, /^73$/m);
  assert.equal(await h.page(url, "typeof globalThis.fixtureEvaluation"), "undefined");
  const accepted = await pi.call("eval", { code }, ["Run all 1 lines"]);
  assert.match(accepted.text, /\b73\b/);
  assert.equal(await h.page(url, "globalThis.fixtureEvaluation"), 73);
  for (const prompt of pi.prompts.slice(1)) {
    assert(prompt.title.includes(code), prompt.title);
    assert(prompt.options?.includes("Run all 1 lines"));
  }
});

test("eval with confirmation disabled needs no UI and awaits the JSON result", async t => {
  const h = await setup(t, { confirmEval: false });
  const pi = await h.session();
  const url = h.url();
  tabId((await pi.call("navigate", { url }, allow)).text, "Pi controls", url);
  // Chromium's replMode supports explicit top-level await; a bare Promise can serialize as {}.
  const { text } = await pi.call("eval", { code: 'await Promise.resolve({ verdict: "ready", count: 4 })' });
  assert.match(text, /"verdict"\s*:\s*"ready"/);
  assert.match(text, /"count"\s*:\s*4/);
  assert.equal(pi.prompts.length, 1);
});

test("Jev finds shipping content and clicks a semantically described target", {
  skip: !process.env.TYPESAFE_API_KEY && "TYPESAFE_API_KEY is not set",
}, async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  tabId((await pi.call("navigate", { url }, allow)).text, "Pi controls", url);
  const { text } = await pi.call("find", { query: "What is the minimum order for free shipping?" });
  assert.match(text, /Shipping is free on orders over \$50/);
  assert.doesNotMatch((await pi.call("click", { target: "button to show the delayed message" })).text, /ambiguous|not found/i);
  assert.doesNotMatch((await pi.call("wait", { text: "Your order shipped" })).text, /timed out|timeout/i);
  assert.equal(await h.page(url, "document.querySelector('#message').textContent"), "Your order shipped");
});

test("network hides denied destinations and frame requests and summarizes data URLs", async t => {
  const h = await setup(t);
  const pi = await h.session();
  assert.equal((await pi.call("navigate", { url: h.url("/redirect") }, [...allow, "Deny"])).text,
    "The user did not allow the browser on private.test.");
  const url = h.url();
  await h.withPage(h.url("/private.html", "private.test"), send => send("Page.navigate", { url }));
  await h.page(url, "document.title");
  // Both a private destination and an approved request issued by a private frame must be hidden.
  await h.page(url, `Promise.all([
    new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.src = ${JSON.stringify(h.url("/network-frame.html?PRIVATE_FRAME_QUERY", "private.test"))};
      frame.onload = () => resolve(true);
      document.body.append(frame);
    }),
    fetch('data:text/plain;base64,REFUQV9TRUNSRVQ=').then(r => r.text()),
  ])`);
  assert(h.requests.some(r => r.host === "controls.test" && r.path === "/frame-request"));
  const network = (await pi.call("network")).text;
  assert.doesNotMatch(network, /private\.test|PRIVATE_FRAME_QUERY|frame-request|REFUQV9TRUNSRVQ=/);
  assert.match(network, /data:text\/plain \(11 bytes\)$/m);
  assert.match(network, /^[1-9]\d* requests to sites you haven't approved are hidden\.$/m);
  assert.match(network, new RegExp(`^GET 200 Document ${escapeRE(url)}$`, "m"));
});
