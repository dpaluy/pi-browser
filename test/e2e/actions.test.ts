import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { image, ref, tabId } from "./assertions.ts";
import { waitUntil } from "./harness.ts";
import { setup } from "./pi.ts";

const allow = ["Allow for this session"];

test("read formats refs and states, includes shadow and same-origin frame content, and redacts a cross-site frame", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/snapshot.html");
  const id = tabId((await pi.call("navigate", { url }, allow)).text, "Snapshot workshop", url);
  const snapshot = (await pi.call("read")).text;
  assert.equal(tabId(snapshot, "Snapshot workshop", url), id);
  assert.match(snapshot, /^ *heading "Snapshot workshop"$/m);
  assert.doesNotMatch(snapshot, /^ *(?:generic|none)\b|^ *Snapshot workshop$/m);
  assert.match(snapshot, /^ *\[\d+\] textbox "Reply address" = "team@example.test" \(required\)$/m);
  assert.match(snapshot, /^ *\[\d+\] checkbox "Receive updates" \(checked\)$/m);
  const pin = snapshot.split("\n").find(line => line.includes('button "Pin notice"')) ?? "";
  assert.match(pin, /\[\d+\] button "Pin notice".*\bpressed\b/);
  assert.match(pin, /\bdisabled\b/);
  ref(snapshot, "link", "Return to controls");
  ref(snapshot, "button", "Shadow action");
  const lines = snapshot.split("\n");
  const local = lines.findIndex(line => /Iframe "Local preview"/.test(line));
  const child = lines.findIndex(line => /heading "Local frame contents"/.test(line));
  assert(local >= 0 && child > local, snapshot);
  assert(lines[child].search(/\S/) >= lines[local].search(/\S/) + 2, "The frame heading is nested under the iframe");
  const inFrame = ref(snapshot, "button", "Use preview");
  assert.match(snapshot, /Iframe "External preview" \(cross-site frame\.test, not read\)/);
  assert.doesNotMatch(snapshot, /Confidential fixture/);
  await pi.call("click", { ref: inFrame });
  assert.equal(await h.page(url, "document.querySelector('iframe').contentDocument.querySelector('button').textContent"), "Frame button used");
});

test("click, keys and type submit a form; a ref from before navigation is stale", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  tabId((await pi.call("navigate", { url }, allow)).text, "Pi controls", url);
  const snapshot = (await pi.call("read")).text;
  const email = ref(snapshot, "textbox", "Email address");
  assert.match((await pi.call("click", { ref: email })).text, /Email address/);
  await pi.call("keys", { keys: "End" });
  await pi.call("type", { text: ".test" });
  await pi.call("keys", { keys: "Enter" });
  const state = await h.page<string>(url, "document.querySelector('#state').textContent");
  assert.match(state, /^submitted /);
  assert.match(state, /old@example\.com\.test/);
  const next = h.url("/private.html");
  tabId((await pi.call("navigate", { url: next })).text, "Confidential fixture title", next);
  assert.equal((await pi.call("click", { ref: email })).text, `Ref [${email}] is not on the page anymore; read again.`);
});

test("ref clicks name a covering element but accept the control's own label", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/interaction.html");
  await pi.call("navigate", { url }, allow);
  const text = (await pi.call("read")).text;
  const covered = ref(text, "button", "Hidden target");
  const toggle = ref(text, "checkbox", "Overlay label");
  assert.match((await pi.call("click", { ref: covered })).text, /Blocking banner/);
  assert.equal(await h.page(url, "document.querySelector('#count').value"), "0");
  await pi.call("click", { ref: toggle });
  assert.equal(await h.page(url, "document.querySelector('#toggle').checked"), true);
});

test("a dialog interrupts a click promptly and leaves the tab usable once answered", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/interaction.html");
  await pi.call("navigate", { url }, allow);
  const open = ref((await pi.call("read")).text, "button", "Open alert");
  // Observe/answer the real alert rather than replacing window.alert in the fixture.
  await h.withPage(url, async send => {
    await send("Page.enable");
    const start = performance.now();
    const { text } = await pi.call("click", { ref: open });
    assert.equal(text, 'The page opened a alert dialog ("Please acknowledge the fixture"); answer it in the browser, then try again.');
    assert(performance.now() - start < 5_000, "Click waited instead of failing promptly on the open dialog");
    await send("Page.handleJavaScriptDialog", { accept: true });
  });
  const blue = ref((await pi.call("read")).text, "button", "Paint blue");
  await pi.call("click", { ref: blue });
  assert.equal(await h.page(url, "document.querySelector('#count').value"), "1");
});

test("background input changes the page and its screenshot without activating the tab", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/interaction.html");
  const id = tabId((await pi.call("navigate", { url }, allow)).text, "Pointer workshop", url);
  const activeId = await h.worker<number>("chrome.tabs.create({url:'about:blank',active:true}).then(t=>t.id)");
  assert.notEqual(activeId, id);
  const blue = ref((await pi.call("read")).text, "button", "Paint blue");
  await pi.call("click", { ref: blue });
  assert.equal(await h.page(url, "document.querySelector('#count').value"), "1");
  const { rgb, width, height } = await image(t, h, url, await pi.call("screenshot"), [8, 8]);
  assert.deepEqual([width, height], await h.page(url, "[visualViewport.width, visualViewport.height]"), "Uncapped screenshot uses CSS viewport pixels");
  assert(rgb?.every((channel, i) => Math.abs(channel - [24, 74, 212][i]) < 12), `Expected painted blue pixel, got ${rgb}`);
  assert.equal(await h.worker(`chrome.tabs.get(${id}).then(t=>t.active)`), false);
  assert.equal(await h.worker(`chrome.tabs.get(${activeId}).then(t=>t.active)`), true);
});

test("large screenshots obey the long-edge and pixel caps, and zoom recaptures a region", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/interaction.html");
  await pi.call("navigate", { url }, allow);
  await h.withPage(url, async send => {
    const resize = (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await resize(2200, 480);
    const wide = await image(t, h, url, await pi.call("screenshot"));
    assert.equal(wide.width, 1568);
    await resize(2000, 1600);
    const tall = await image(t, h, url, await pi.call("screenshot"));
    assert(tall.width < wide.width, "The area cap must further constrain a taller viewport");
    assert(Math.abs(tall.width / tall.height - 1.25) < 0.01, "Resizing preserves viewport aspect ratio");
    // The region is [x, y, width, height] in screenshot pixels, entirely in the green top margin.
    const zoom = await image(t, h, url, await pi.call("zoom", { region: [0, 0, 100, 20] }), [8, 8]);
    assert(zoom.width > 100 && zoom.height > 20, "Recapture increases the crop's resolution");
    assert(zoom.width / zoom.height > 4.8 && zoom.width / zoom.height < 5.2, "Zoom preserves the region's shape");
    assert(zoom.width <= Math.ceil(400 * 2000 / tall.width), "Zoom is at most 4× CSS resolution");
    assert(zoom.rgb?.every((channel, i) => Math.abs(channel - [25, 145, 84][i]) < 12), `Expected green crop, got ${zoom.rgb}`);
  });
});

test("screenshot points hover, draw, scroll an inner panel and drop an HTML5 payload", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/interaction.html");
  await pi.call("navigate", { url }, allow);
  assert.equal((await pi.call("hover", { point: [20, 20] })).text, "Take a screenshot first; points are in its pixels.");
  const shot = await image(t, h, url, await pi.call("screenshot"));
  const point = async (id: string, x = 0.5, y = 0.5) => h.page<[number, number]>(url, `(() => {
    const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return [Math.round((r.left + r.width * ${x}) * ${shot.width} / visualViewport.width),
            Math.round((r.top + r.height * ${y}) * ${shot.height} / visualViewport.height)];
  })()`);
  await pi.call("hover", { point: await point("hover-menu") });
  assert.equal(await h.page(url, "getComputedStyle(document.querySelector('#menu-entry')).visibility"), "visible");
  await pi.call("drag", { point: await point("canvas", 0.15), to: await point("canvas", 0.85) });
  const moves = await h.page<[string, number, number][]>(url, "window.pointerLog");
  assert.equal(moves[0]?.[0], "pointerdown");
  assert.equal(moves.at(-1)?.[0], "pointerup");
  assert(moves.filter(([type]) => type === "pointermove").length >= 3, JSON.stringify(moves));
  assert(moves.at(-1)![1] > moves[0][1] + 100);
  await pi.call("scroll", { point: await point("panel"), delta: [0, 240] });
  await waitUntil("inner panel scroll", async () => await h.page<number>(url, "document.querySelector('#panel').scrollTop") > 0 ? true : undefined);
  assert.equal(await h.page(url, "scrollY"), 0);
  await pi.call("drag", { point: await point("source"), to: await point("drop") });
  assert.equal(await h.page(url, "document.querySelector('#drop-result').value"), "fixture parcel");
});

test("fill replaces text, fires events, stops on error, and select supports labels and values", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  await pi.call("navigate", { url }, allow);
  const text = (await pi.call("read")).text;
  const email = ref(text, "textbox", "Email address");
  const country = ref(text, "combobox", "Country");
  const news = ref(text, "checkbox", "Subscribe to newsletter");
  const toppings = ref(text, "listbox", "Toppings");
  await h.page(url, `(() => {
    window.fillEvents = [];
    for (const type of ['input', 'change']) document.querySelector('#email').addEventListener(type, () => fillEvents.push(type));
  })()`);
  await pi.call("fill", { fields: [{ ref: email, value: "new@example.test" }, { ref: news, value: "true" }] });
  assert.equal(await h.page(url, "document.querySelector('#email').value"), "new@example.test");
  assert.equal(await h.page(url, "document.querySelector('#news').checked"), true);
  assert.deepEqual(new Set(await h.page<string[]>(url, "window.fillEvents")), new Set(["input", "change"]));
  const partial = (await pi.call("fill", { fields: [{ ref: email, value: "" }, { ref: country, value: "Atlantis" }, { ref: news, value: "false" }] })).text;
  assert.match(partial, /Atlantis/);
  assert.match(partial, /Email address|1 (?:field|filled)|\[\d+\]/i);
  assert.equal(await h.page(url, "document.querySelector('#email').value"), "");
  assert.equal(await h.page(url, "document.querySelector('#news').checked"), true);
  const disabled = (await pi.call("select", { ref: country, values: ["jp"] })).text;
  assert.match(disabled, /disabled/i);
  await pi.call("select", { ref: country, values: ["CANADA"] });
  await pi.call("select", { ref: toppings, values: ["Olives", "basil"] });
  assert.deepEqual(await h.page(url, "[document.querySelector('#country').value, ...Array.from(document.querySelector('#toppings').selectedOptions, o => o.value)]"), ["ca", "Olives", "Basil"]);
});

test("upload confirms absolute paths, attaches nothing on denial, and handles file chooser buttons", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  await pi.call("navigate", { url }, allow);
  const text = (await pi.call("read")).text;
  // Native file inputs expose the AX button role.
  const avatar = ref(text, "button", "Avatar");
  const attach = ref(text, "button", "Attach documents");
  await writeFile(join(h.root, "dispatch.txt"), "parcel\n");
  await writeFile(join(h.root, "receipt.txt"), "ok\n");
  const names = (id: string) => h.page<string[]>(url, `Array.from(document.getElementById(${JSON.stringify(id)}).files, f => f.name)`);
  await pi.call("upload", { ref: avatar, paths: ["dispatch.txt"] }, [false]);
  assert.deepEqual(await names("avatar"), []);
  await pi.call("upload", { ref: avatar, paths: ["dispatch.txt"] }, [true]);
  assert.deepEqual(await names("avatar"), ["dispatch.txt"]);
  await pi.call("upload", { ref: attach, paths: ["dispatch.txt", "receipt.txt"] }, [true]);
  assert.deepEqual(await names("documents"), ["dispatch.txt", "receipt.txt"]);
  const prompts = pi.prompts.slice(1).map(p => [p.title, p.message].filter(Boolean).join("\n"));
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /Let the agent attach/);
    assert(prompt.includes("controls.test") && prompt.includes(join(h.root, "dispatch.txt")), prompt);
  }
  assert(prompts[2].includes(join(h.root, "receipt.txt")), prompts[2]);
});

test("wait watches the page; back, forward, reload and close preserve tab identity", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const first = h.url();
  const second = h.url("/interaction.html");
  const id = tabId((await pi.call("navigate", { url: first }, allow)).text, "Pi controls", first);
  assert.equal((await pi.call("forward")).text, `Tab ${id} has no page to go forward to.`);
  const later = ref((await pi.call("read")).text, "button", "Show message later");
  await pi.call("click", { ref: later });
  const waited = (await pi.call("wait", { text: "YOUR ORDER SHIPPED" })).text;
  assert.doesNotMatch(waited, /timed out|timeout/i);
  assert.equal(await h.page(first, "document.querySelector('#message').textContent"), "Your order shipped");
  await h.page(first, "void setTimeout(() => { document.querySelector('#message').textContent = ''; }, 350)");
  assert.doesNotMatch((await pi.call("wait", { text: "Your order shipped", gone: true })).text, /timed out|timeout/i);
  assert.equal(await h.page(first, "document.querySelector('#message').textContent"), "");
  assert.equal(tabId((await pi.call("navigate", { url: second })).text, "Pointer workshop", second), id);
  assert.equal(tabId((await pi.call("back")).text, "Pi controls", first), id);
  assert.equal(tabId((await pi.call("forward")).text, "Pointer workshop", second), id);
  const before = h.requests.filter(r => r.path === "/interaction.html").length;
  assert.equal(tabId((await pi.call("reload")).text, "Pointer workshop", second), id);
  assert(h.requests.filter(r => r.path === "/interaction.html").length > before);
  assert.equal((await pi.call("close")).text, `Closed tab ${id}.`);
  assert.equal(await h.worker(`chrome.tabs.query({}).then(tabs=>tabs.some(t=>t.id===${id}))`), false);
});

test("a navigation that never finishes returns a still-loading header", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/slow");
  const { text } = await pi.call("navigate", { url }, allow);
  tabId(text, "Unfinished fixture", url);
  assert.match(text, /\(still loading\)/);
  assert.notEqual(await h.page(url, "document.readyState"), "complete");
});

test("point click asks for the redirected frame's committed host", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  await pi.call("navigate", { url }, allow);
  await h.page(url, `new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.src = '/redirect-frame';
    frame.style = 'position:fixed; top:0; left:0; width:300px; height:150px; z-index:9999';
    frame.onload = () => resolve(true);
    document.body.append(frame);
  })`);
  assert.equal((await pi.call("screenshot")).images.length, 1);
  assert.equal((await pi.call("click", { point: [40, 20] }, ["Deny"])).text,
    "The user did not allow the browser on private.test.");
});

test("upload asks for the redirected frame's committed host before using a ref", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  await pi.call("navigate", { url }, allow);
  await h.page(url, `new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.src = '/approval-frame.html';
    frame.onload = () => resolve(true);
    document.body.append(frame);
  })`);
  const file = ref((await pi.call("read")).text, "button", "Frame file");
  await h.page(url, `new Promise(resolve => {
    const frame = document.querySelector('iframe');
    frame.onload = () => resolve(true);
    frame.src = '/redirect-frame';
  })`);
  await writeFile(join(h.root, "frame.txt"), "fixture\n");
  await pi.call("upload", { ref: file, paths: ["frame.txt"] }, [true, false]);
  assert.match(pi.prompts.at(-1)!.title, /private\.test/);
});

test("redirect to a private alert requests approval without revealing its message or replaying", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url("/redirect-alert");
  const { text } = await pi.call("navigate", { url }, ["Allow once", "Allow for this session"]);
  assert.doesNotMatch(text, /PRIVATE_DIALOG_MARKER/);
  assert.equal(text, "The browser action already ran and reached private.test; it was not repeated. Read the page before continuing.");
  assert.equal(h.requests.filter(r => r.path === "/redirect-alert").length, 1);
  assert.equal(pi.prompts.at(-1)!.title, "Let the agent use private.test in the browser?");
});

test("target=_blank leaves the user's tab active and the opener current", async t => {
  const h = await setup(t);
  const pi = await h.session();
  const url = h.url();
  const id = tabId((await pi.call("navigate", { url }, allow)).text, "Pi controls", url);
  const active = await h.worker<number>("chrome.tabs.query({active:true}).then(([tab])=>tab.id)");
  await h.page(url, `(() => {
    const link = document.createElement('a');
    link.href = '/interaction.html';
    link.target = '_blank';
    link.rel = 'opener';
    link.textContent = 'Open workshop';
    document.body.prepend(link);
  })()`);
  const open = ref((await pi.call("read")).text, "link", "Open workshop");
  assert.match((await pi.call("click", { ref: open })).text, /Clicked/);
  const tabs = await h.worker<{ id: number; active: boolean; openerTabId?: number; url: string; groupId: number }[]>("chrome.tabs.query({})");
  const opened = tabs.find(tab => tab.url === h.url("/interaction.html"));
  assert(opened, JSON.stringify(tabs));
  assert.equal(opened.active, false, "The opened tab stole focus");
  assert.equal(await h.worker(`chrome.tabs.get(${active}).then(tab=>tab.active)`), true);
  const list = (await pi.call("tabs")).text;
  assert.match(list, new RegExp(`^Tab ${opened.id}:`, "m"));
  assert.match(list, new RegExp(`^Tab ${id}:.*\\(current\\)$`, "m"));
});
