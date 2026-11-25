import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, SessionManager, SettingsManager, type ExtensionFactory, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { covers } from "../src/approvals.ts";
import { browserExtension, type BrowserOptions } from "../src/index.ts";
import { formatFind, resolveTarget } from "../src/targets.ts";
import type { browserSchema } from "../src/tool.ts";
import { view } from "../src/view.ts";

// Site approval is off by default; tests that exercise approval prompts turn it on.
async function fixture(t: TestContext, approveSites = true) {
  const root = await mkdtemp("/tmp/pibr-pi-");
  t.after(() => rm(root, { recursive: true, force: true }));
  if (approveSites) {
    await mkdir(join(root, "browser"), { recursive: true });
    await writeFile(join(root, "browser", "settings.json"), JSON.stringify({ approveSites: true }));
  }
  return root;
}

async function pi(t: TestContext, root: string, options: { mode?: "tui" | "rpc" | "print" | "json"; loadFromDisk?: boolean; env?: BrowserOptions["env"]; also?: ExtensionFactory[] } = {}) {
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
    : { extensionFactories: [browserExtension({ agentDir: root, browserDirs: [], env: options.env ?? {}, connectTimeoutMs: 1000 }), ...options.also ?? []] };
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

async function decisionPeer<Body>(t: TestContext, respond: (body: Body, response: ServerResponse) => void) {
  const seen: { path?: string; method?: string; headers: IncomingMessage["headers"]; body: Body }[] = [];
  const server = createServer(async (request, response) => {
    request.setEncoding("utf8");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    seen.push({ path: request.url, method: request.method, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    respond(body, response);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, seen };
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
  assert.match(app.notifications.at(-1) ?? "", /^Pi Browser is not connected\. .*\nExtension folder: \/.+\/extension$/m);
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
    const app = await pi(t, root, { env: { TYPESAFE_API_KEY: key } });
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
  assert.match(app.notifications.at(-1) ?? "", /Decision model: none \(find and target are off\)$/);
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
  const app = await pi(t, root, { env: { TYPESAFE_API_KEY: "test-key" } });
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
  app.answers.push("Run page JavaScript without asking");
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

test("by default the tool works on any site without asking; covered grants include subdomains", { timeout: 8000 }, async t => {
  const root = await fixture(t, false);
  const app = await pi(t, root);
  const requests = await browserPeer(t, app, request => request.method === "tabs"
    ? { result: { tabs: [{ id: 4, current: true, title: "Shop", url: "https://shop.test/cart" }], others: 2 } }
    : covers(request.allowed, "any.test") ? reply("done") : error("any.test"));
  assert.equal(await app.call("navigate", { url: "https://any.test/" }), "done");
  assert.equal(await app.call("tabs"), "Tab 4: Shop <https://shop.test/cart> (current)\n2 other tabs are not in your group.");
  assert.deepEqual(requests.map(request => request.allowed), [["*"], ["*"]]);
  assert.equal(app.prompts.length, 0);

  // Uploads still confirm the files for each destination and send only confirmed ones.
  const file = join(root, "memo.txt");
  await writeFile(file, "fixture");
  app.answers.push(true, false);
  await assert.rejects(app.call("upload", { ref: 1, paths: [file] }), { message: "The user did not allow the browser upload on any.test." });
  assert.deepEqual(requests.at(-1)?.allowed, ["shop.test"]);
  assert.deepEqual(app.prompts.map(prompt => prompt.question.replace(/".*"/, "<file>")),
    ["Let the agent attach <file> to a page on shop.test?", "Let the agent attach <file> to a page on any.test?"]);
  app.prompts.length = 0;

  // Turning site approval on makes Pi ask; a grant saved for www.<site> covers the site and its subdomains only.
  app.answers.push("Ask before the agent uses a new site");
  await app.session.prompt("/browser settings");
  assert.equal(JSON.parse(await readFile(join(root, "browser", "settings.json"), "utf8")).approveSites, true);
  let host = "www.store.test";
  const next = await pi(t, root);
  const nextRequests = await browserPeer(t, next, request => covers(request.allowed, host) ? reply("ok") : error(host));
  next.answers.push("Always allow");
  assert.equal(await next.call("read"), "ok");
  assert.deepEqual(JSON.parse(await readFile(join(root, "browser", "settings.json"), "utf8")).alwaysAllow, ["store.test"]);
  host = "api.store.test";
  assert.equal(await next.call("read"), "ok");
  assert.equal(next.prompts.length, 1);
  host = "badstore.test";
  next.answers.push("Deny");
  await assert.rejects(next.call("read"), { message: "The user did not allow the browser on badstore.test." });
  assert.deepEqual(nextRequests.at(-1)?.allowed, ["store.test"]);
});

test("/browser <task> asks the agent to do the task with the browser tool", { timeout: 8000 }, async t => {
  const root = await fixture(t, false);
  const sent: { text: string; source: string }[] = [];
  const app = await pi(t, root, { also: [pi => {
    pi.on("input", event => {
      sent.push({ text: event.text, source: event.source });
      return { action: "handled" };
    });
  }] });
  await app.session.prompt("/browser visit majesticlabs.dev and explain what this company does");
  assert.deepEqual(sent, [{
    text: "Use the browser tool, which works in my own Chrome or Brave, for this: visit majesticlabs.dev and explain what this company does",
    source: "extension",
  }]);
  assert.deepEqual(app.notifications, []);
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
  const app = await pi(t, root, { env: { TYPESAFE_API_KEY: "test-key" } });
  const snapshot = 'Tab 42: Sample <https://example.test/form>\n[11] textbox "Email"\n[12] textbox "Name"';
  const requests = await browserPeer(t, app, ({ method }) => method === "read" ? reply(snapshot) : reply("Filled"));
  assert.match(app.notifications.at(-1) ?? "", /Decision model: TypeSafe jev-latest/);
  let retry = true;
  const upstream = "https://api.typesafe.ai";
  let ambiguous = false;
  const http = await decisionPeer<{ model: string; state: Record<string, string>; questions: Record<string, unknown> }>(t, (body, response) => {
    if (retry) {
      retry = false;
      response.writeHead(429, { "Retry-After": "1" }).end();
      return;
    }
    response.end(JSON.stringify({ answers: {
      exists0: { noul: 0.95 }, ambiguous0: { noul: 0 }, where0: { probabilities: { L1: 1 } },
      ...(Object.hasOwn(body.questions, "where1") && {
        exists1: { noul: 0.9 }, ambiguous1: { noul: ambiguous ? 0.8 : 0 }, where1: { probabilities: { L2: 1 } },
      }),
    } }));
  });
  // Route the hard-coded production endpoint to the local server, retaining real fetch and HTTP.
  const fetchHttp = globalThis.fetch;
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    urls.push(url);
    return fetchHttp(url.replace(upstream, http.url), init);
  });
  const fields = [{ target: "email", value: "person@example.test" }, { target: "name", value: "A Person" }];
  assert.equal(await app.call("fill", { fields }), 'Matched "email" → [11] textbox "Email" (95%)\nMatched "name" → [12] textbox "Name" (90%)\nFilled');
  assert.deepEqual(requests.map(req => req.method), ["read", "fill"]);
  assert.deepEqual(requests[1].params, { tabId: 42, fields: [{ ref: 11, value: fields[0].value }, { ref: 12, value: fields[1].value }] });
  assert.deepEqual(urls, Array(2).fill(`${upstream}/v1/systemone`));
  const [first, second] = http.seen;
  assert.deepEqual(first.body, second.body);
  assert.equal(first.method, "POST");
  assert.equal(first.path, "/v1/systemone");
  assert.equal(first.headers.authorization, "Bearer test-key");
  assert.equal(first.headers["content-type"], "application/json");
  assert.equal(first.body.model, "jev-latest");
  assert.deepEqual(first.body.state, { tab: snapshot.split("\n")[0], page: 'L1| [11] textbox "Email"\nL2| [12] textbox "Name"' });
  assert.deepEqual(Object.keys(first.body.questions), ["where0", "exists0", "ambiguous0", "where1", "exists1", "ambiguous1"]);
  assert.deepEqual(first.body.questions.where0, {
    type: "choice",
    instructions: '`page` is a web page\'s accessibility tree, one line per id; lines with a [number] are elements a user can act on. Which element should be used for: "email"?',
    criteria: { L1: null, L2: null },
  });
  const exists = first.body.questions.exists0 as { type: string; criteria: unknown };
  assert.equal(exists.type, "noul");
  assert.deepEqual(exists.criteria, {
    true: "A line with a [number] is clearly the element described", false: "No line with a [number] is the element described",
  });
  ambiguous = true;
  await assert.rejects(app.call("fill", { fields }), /"name" fits more than one element \(80% likely\), so nothing was done/);
  assert.deepEqual(requests.map(req => req.method), ["read", "fill", "read"]);
  assert.equal(await app.call("find", { query: "email" }), '"email": found on this page (match 95%).\nline 2 (95%): [11] textbox "Email"');
  assert.deepEqual(Object.keys(http.seen[3].body.questions), ["where0", "exists0"]);
});

test("OpenAI is selected from disk and scores target and find over chat completions", { timeout: 8000 }, async t => {
  const root = await fixture(t);
  const snapshot = ['Tab 42: Sample <https://example.test/form>', ...Array.from({ length: 11 }, (_, i) => `[${i + 1}] button "Item ${i + 1}"`), '[42] button "Save"'].join("\n");
  const token = (token: string, p: number) => ({ token, logprob: Math.log(p) });
  let failure: "missing" | "invalid" | undefined;
  const http = await decisionPeer<{ messages: { role: string; content: string }[]; max_tokens: number }>(t, (body, response) => {
    const prompt = body.messages[0].content;
    const isChoice = body.max_tokens === 4;
    const ambiguous = prompt.includes('reasonably mean two or more');
    const answer = isChoice ? failure === "invalid" ? "Save" : " 12" : ambiguous ? " nO" : " YES";
    const content = isChoice ? failure === "invalid" ? [token("Save", 0.9)]
      : [token(" 1", 0.92), token("2", 0.81), token("\n", 0.3)]
      : [{ ...token(answer, 0.2), top_logprobs: ambiguous
        ? [token(" nO", 0.2), token("no\n", 0.25), token("Yes", 0.05)]
        : [token(" YES", 0.2), token("yes\n", 0.2), token("No", 0.05), token(" nO", 0.05), token("Other", 0.5)] }];
    response.end(JSON.stringify({ choices: [{ message: { content: answer }, ...(failure === "missing" && isChoice ? {} : { logprobs: { content } }) }] }));
  });
  const baseUrl = `${http.url}/v1`;
  await writeFile(join(root, "browser", "settings.json"), JSON.stringify({ decision: { provider: "openai", baseUrl, model: "local-test" } }));
  const app = await pi(t, root, { env: { TYPESAFE_API_KEY: "must-not-be-used" } });
  const definition = app.session.getToolDefinition("browser");
  assert(definition);
  const props = (definition.parameters as ReturnType<typeof browserSchema>).properties;
  assert(props.action.enum.includes("find"));
  assert(Object.hasOwn(props, "target"));
  assert(Object.hasOwn(props.fields.items.properties, "target"));
  const requests = await browserPeer(t, app, ({ method }) => method === "read" ? reply(snapshot) : reply("Clicked"));
  assert.match(app.notifications.at(-1) ?? "", /Decision model: local-test at http:\/\/127\.0\.0\.1:\d+\/v1/);
  assert.equal(await app.call("click", { target: "save button" }), 'Matched "save button" → [42] button "Save" (60%)\nClicked');
  assert.deepEqual(requests.map(req => [req.method, req.params]), [["read", {}], ["click", { ref: 42, tabId: 42 }]]);
  assert.equal(await app.call("find", { query: "save" }), '"save": found on this page (match 80%).\nline 13 (60%): [42] button "Save"');
  assert.equal(http.seen.length, 5);
  for (const { method, path, headers, body } of http.seen) {
    assert.equal(method, "POST");
    assert.equal(path, "/v1/chat/completions");
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["content-type"], "application/json");
    const { messages, max_tokens, ...args } = body;
    assert.deepEqual(args, { model: "local-test", temperature: 0, logprobs: true, top_logprobs: 20 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "user");
    assert.match(messages[0].content, /Tab 42: Sample .*\[42\] button "Save"/s);
    if (max_tokens === 4) assert.match(messages[0].content, /^1 = L1\n(?:.*\n)*12 = L12$/m);
    else {
      assert.equal(max_tokens, 1);
      assert.match(messages[0].content, /Your answer \(no or yes\):/);
      assert.match(messages[0].content, /^no — .+\nyes — .+$/m);
    }
  }
  failure = "missing";
  await assert.rejects(app.call("find", { query: "save" }), { message: `The decision model at ${baseUrl} (local-test) did not return token probabilities. Use a model and server that return logprobs, with thinking turned off.` });
  failure = "invalid";
  await assert.rejects(app.call("click", { target: "save button" }), /returned "Save" instead of a valid option label/);
  assert.deepEqual(requests.map(req => req.method), ["read", "click", "read", "read", "read"]);
});
