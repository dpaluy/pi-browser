import assert from "node:assert/strict";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Browser, computeExecutablePath, detectBrowserPlatform, install, launch, resolveBuildId, type Process } from "@puppeteer/browsers";

const extensionDir = fileURLToPath(new URL("../../extension/", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const extensionId = "odhaeafpfooplfbcefglfcmlpbedofdo";

export async function waitUntil<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = await probe();
    if (result !== undefined) return result;
    await delay(50);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export async function serveFixtures() {
  const requests: { host: string; path: string; method: string }[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    requests.push({ host: url.hostname, path: url.pathname, method: req.method! });
    res.setHeader("Cache-Control", "no-store");
    switch (url.pathname) {
      case "/redirect":
        res.writeHead(302, { Location: `http://private.test:${url.port}/private.html` }).end();
        return;
      case "/redirect-frame":
        res.writeHead(302, { Location: `http://private.test:${url.port}/approval-frame.html` }).end();
        return;
      case "/redirect-alert":
        res.writeHead(302, { Location: `http://private.test:${url.port}/alert.html` }).end();
        return;
      case "/slow":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.write('<!doctype html><title>Unfinished fixture</title><p>Waiting for the rest.</p><img src="/never">');
        return;
      case "/never":
        res.writeHead(200, { "Content-Type": "image/png" }).flushHeaders();
        return;
      case "/api/parcel":
        res.writeHead(200, { "Content-Type": "text/plain", "X-Fixture-Response": "response-header-secret" })
          .end("response-body-secret");
        return;
    }
    if (!/^\/[a-z-]+\.html$/.test(url.pathname)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(fixtures, url.pathname.slice(1)));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    } catch (err) {
      res.writeHead((err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500).end();
    }
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: (path = "/controls.html", host = "controls.test") => `http://${host}:${address.port}${path}`,
    requests,
    close: () => new Promise<void>((done, fail) => {
      server.close(err => err ? fail(err) : done());
      server.closeAllConnections();
    }),
  };
}

type Target = { targetId: string; type: string; url: string };
type Reply = { id?: number; result?: unknown; error?: { message: string } };

class CDP {
  private id = 0;
  private pending = new Map<number, (reply: Reply) => void>();
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data)) as Reply;
      if (reply.id !== undefined) this.pending.get(reply.id)?.(reply);
    });
    ws.addEventListener("close", () => {
      for (const settle of this.pending.values()) settle({ error: { message: "DevTools connection closed" } });
    });
  }

  static async connect(endpoint: string) {
    const ws = new WebSocket(endpoint);
    try {
      await new Promise<void>((ok, fail) => {
        const timeout = setTimeout(() => fail(new Error(`Could not open ${endpoint}`)), 5_000);
        ws.addEventListener("open", () => { clearTimeout(timeout); ok(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timeout); fail(new Error(`Could not open ${endpoint}`)); }, { once: true });
      });
      return new CDP(ws);
    } catch (err) {
      ws.close();
      throw err;
    }
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    return new Promise<T>((ok, fail) => {
      const id = ++this.id;
      const finish = (reply: Reply) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (reply.error) fail(new Error(`${method}: ${reply.error.message}`));
        else ok(reply.result as T);
      };
      const timer = setTimeout(() => finish({ error: { message: "timed out" } }), 8_000);
      this.pending.set(id, finish);
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (err) {
        finish({ error: { message: String(err) } });
      }
    });
  }

  async withTarget<T>(target: Target, run: (send: CDPSend) => Promise<T>): Promise<T> {
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    try {
      return await run((method, params) => this.send(method, params, sessionId));
    } finally {
      await this.send("Target.detachFromTarget", { sessionId });
    }
  }

  targets = async () => (await this.send<{ targetInfos: Target[] }>("Target.getTargets")).targetInfos;
  close = () => this.ws.close();
}

type CDPSend = <T = unknown>(method: string, params?: object) => Promise<T>;

async function evaluate<T>(send: CDPSend, expression: string): Promise<T> {
  const reply = await send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true },
  );
  if (reply.exceptionDetails) {
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  }
  return reply.result.value;
}

let cachedExecutable: Promise<string> | undefined;
async function installChrome() {
  const platform = detectBrowserPlatform();
  assert(platform, `No Chrome for Testing build for ${process.platform}/${process.arch}`);
  const browser = Browser.CHROME;
  const cacheDir = join(homedir(), ".cache", "pi-browser");
  const cached = computeExecutablePath({ browser, platform, cacheDir, buildId: "stable" });
  try {
    await access(cached, constants.X_OK);
    return cached;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const buildId = await resolveBuildId(browser, platform, "stable");
  return (await install({ browser, platform, buildId, buildIdAlias: "stable", cacheDir })).executablePath;
}

/** Browser-only entry point; also usable for a scratch MV3 smoke test without the Pi module. */
export async function startBrowser(options: {
  path?: string;
  expectedId?: string;
  beforeLaunch?: (dirs: { agentDir: string; profileDir: string; socketsDir: string }) => Promise<unknown>;
  signal?: AbortSignal;
} = {}) {
  const executablePath = process.env.E2E_BROWSER ? resolve(process.env.E2E_BROWSER) : await (cachedExecutable ??= installChrome());
  // Keep unix socket paths short even when TMPDIR (notably on macOS) is long.
  const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pibr-e2e-"));
  const agentDir = join(root, "agent");
  const profileDir = join(root, "profile");
  const socketsDir = join(agentDir, "browser", "sockets");
  let chrome: Process | undefined;
  let cdp: CDP | undefined;
  let http: Awaited<ReturnType<typeof serveFixtures>> | undefined;
  const close = async () => {
    try {
      cdp?.close();
      await chrome?.close();
    } finally {
      try { await http?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  };
  try {
    await mkdir(profileDir);
    await mkdir(socketsDir, { recursive: true, mode: 0o700 });
    await options.beforeLaunch?.({ agentDir, profileDir, socketsDir });
    http = await serveFixtures();
    chrome = launch({ executablePath, signal: options.signal, args: [
      "--headless=new", `--user-data-dir=${profileDir}`, "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
      "--host-resolver-rules=MAP *.test 127.0.0.1", "--no-proxy-server", "--window-size=1000,800",
      "about:blank",
    ] });
    const endpoint = await waitUntil("DevToolsActivePort", async () => {
      if (chrome!.nodeProcess.exitCode !== null) throw new Error("Chrome exited before DevTools started");
      try {
        const [port, path] = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).trim().split("\n");
        if (port && path) return `ws://127.0.0.1:${port}${path}`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }, 15_000);
    const devtools = cdp = await CDP.connect(endpoint);
    const { id } = await devtools.send<{ id: string }>("Extensions.loadUnpacked", { path: resolve(options.path ?? extensionDir) });
    assert.equal(id, options.expectedId ?? extensionId);
    const getWorker = () => waitUntil(`extension ${id} service worker`, async () =>
      (await devtools.targets()).find(target => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`)));
    const worker = async <T>(expression: string) => devtools.withTarget(await getWorker(), send => evaluate<T>(send, expression));
    // A worker target can be listed before its extension bindings are initialized.
    await waitUntil(`extension ${id} bindings`, async () =>
      await worker<string | undefined>("globalThis.chrome?.runtime?.id") === id ? true : undefined);
    const withPage = async <T>(url: string, run: (send: CDPSend) => Promise<T>) => {
      const target = await waitUntil(`page ${url}`, async () =>
        (await devtools.targets()).find(target => target.type === "page" && target.url === url));
      return devtools.withTarget(target, run);
    };
    return {
      agentDir, profileDir, socketsDir, root, ...http, close,
      worker,
      page: <T>(url: string, expression: string) => withPage(url, send => evaluate<T>(send, expression)),
      withPage,
    };
  } catch (err) {
    const logs = chrome?.getRecentLogs().slice(-12).join("\n");
    await close();
    throw new Error(`Starting Chrome for Testing: ${String(err)}${logs ? `\n${logs}` : ""}`, { cause: err });
  }
}
