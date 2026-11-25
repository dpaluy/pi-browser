import { EventEmitter, once } from "node:events";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export const PROTOCOL = 1;
export const versionError = (peer: unknown) => `Pi Browser protocol mismatch (Pi ${PROTOCOL}, extension ${String(peer)}). Reload the extension in chrome://extensions and run /reload in Pi.`;

export interface TabInfo { id: number; title: string; url: string; current: boolean }
export interface BrowserResult {
  text?: string;
  tabs?: TabInfo[];
  others?: number;
  image?: { data: string; mimeType: "image/jpeg"; width: number; height: number };
}
export interface BrowserFailure { message: string; code?: string; host?: string; acted?: boolean }

export class BrowserRequestError extends Error {
  readonly failure: BrowserFailure;
  constructor(failure: BrowserFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

interface Pending {
  socket: Socket;
  settle: (error?: Error, result?: BrowserResult) => void;
}

const disconnected = () => new Error("Pi Browser disconnected. Reload the extension in chrome://extensions and try again.");
const wire = (value: unknown) => `${JSON.stringify(value)}\n`;

async function listen(server: Server, path: string) {
  server.listen(path);
  await once(server, "listening");
}

async function removeStaleSocket(path: string) {
  const previous = await lstat(path);
  if (!previous.isSocket()) return false;
  const probe = createConnection(path);
  try {
    await once(probe, "connect");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
    const current = await lstat(path);
    if (previous.dev !== current.dev || previous.ino !== current.ino) return false;
    await unlink(path);
    return true;
  } finally {
    probe.destroy();
  }
}

export class SessionServer {
  private readonly session: string;
  private readonly name: () => string;
  private readonly server = createServer(socket => this.accept(socket));
  private readonly events = new EventEmitter().setMaxListeners(0);
  private readonly pending = new Map<number, Pending>();
  private socket: Socket | undefined;
  private hello: { extension: string; browser: string; on: boolean } | undefined;
  private failure: Error | undefined;
  private closed = false;
  private sequence = 0;

  private constructor(session: string, name: () => string) {
    this.session = session;
    this.name = name;
  }

  static async open(dir: string, session: string, name: () => string): Promise<SessionServer> {
    if (!/^[\w-]+$/.test(session)) throw new Error("Invalid Pi session ID for the browser socket.");
    const path = join(dir, `${session}.sock`);
    // Node otherwise silently truncates unix socket paths past sockaddr_un.sun_path.
    if (Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107)) {
      throw new Error(`Pi Browser socket path is too long: ${path}. Use a shorter Pi agent directory.`);
    }
    await mkdir(dir, { mode: 0o700, recursive: true });
    await chmod(dir, 0o700);
    const server = new SessionServer(session, name);
    try {
      await listen(server.server, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || !await removeStaleSocket(path)) throw error;
      await listen(server.server, path);
    }
    try {
      await chmod(path, 0o600);
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  get connected(): boolean {
    return Boolean(this.hello && this.socket?.writable);
  }

  get status(): string {
    if (this.hello?.on === false) return `Connected to ${this.hello.browser}, but Pi Browser is turned off in the browser. Click its toolbar icon to turn it on.`;
    if (this.hello) return `Connected to ${this.hello.browser} (extension ${this.hello.extension}).`;
    return this.failure?.message ?? "Pi Browser is not connected. Load the extension in chrome://extensions and click its toolbar icon.";
  }

  private accept(socket: Socket) {
    socket.on("error", () => socket.destroy());
    if (this.closed || (this.socket && !this.socket.destroyed)) {
      socket.end(wire({ refused: "another browser profile is connected" }));
      return;
    }
    this.socket = socket;
    this.hello = undefined;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (data: string) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { socket.destroy(); return; }
        if (!this.receive(socket, message)) return;
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.hello = undefined;
      }
      for (const pending of this.pending.values()) {
        if (pending.socket === socket) pending.settle(disconnected());
      }
    });
  }

  private receive(socket: Socket, message: {
    hello?: { protocol?: unknown; extension?: string; browser?: string; on?: unknown };
    state?: { on?: unknown };
    id?: number; error?: BrowserFailure; result?: BrowserResult;
  }): boolean {
    if (!this.hello) {
      if (message.hello?.protocol !== PROTOCOL) {
        this.failure = new Error(versionError(message.hello?.protocol));
        this.events.emit("change");
        socket.end(wire({ error: { message: this.failure.message } }));
        return false;
      }
      if (typeof message.hello.extension !== "string" || typeof message.hello.browser !== "string") {
        socket.destroy();
        return false;
      }
      this.failure = undefined;
      this.hello = { extension: message.hello.extension, browser: message.hello.browser, on: message.hello.on !== false };
      socket.write(wire({ hello: { protocol: PROTOCOL, session: this.session, name: this.name() } }));
      this.events.emit("change");
    } else if (typeof message.state?.on === "boolean") {
      this.hello.on = message.state.on;
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending?.socket === socket) {
        if (typeof message.error?.message === "string") pending.settle(new BrowserRequestError(message.error));
        else if (message.result && typeof message.result === "object") pending.settle(undefined, message.result);
        else pending.settle(new Error("Invalid response from the Pi Browser extension."));
      }
    }
    return true;
  }

  async connect(timeout: number, signal?: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(timeout);
    const waitSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    while (true) {
      signal?.throwIfAborted();
      if (this.closed) throw disconnected();
      if (this.hello && this.socket?.writable) return;
      if (this.failure) throw this.failure;
      try {
        await once(this.events, "change", { signal: waitSignal });
      } catch (error) {
        signal?.throwIfAborted();
        if (deadline.aborted) throw new Error(this.status);
        throw error;
      }
    }
  }

  request(method: string, params: object, allowed: string[], timeout: number, signal?: AbortSignal): Promise<BrowserResult> {
    signal?.throwIfAborted();
    const socket = this.socket;
    if (!this.hello || !socket?.writable) throw disconnected();
    const id = ++this.sequence;
    const data = wire({ id, method, params, allowed, name: this.name() });
    return new Promise((resolve, reject) => {
      const settle = (error?: Error, result?: BrowserResult) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => settle(signal?.reason ?? new Error("Browser request cancelled."));
      const timer = setTimeout(() => settle(new Error(`Browser ${method} request timed out after ${timeout / 1000} s.`)), timeout);
      this.pending.set(id, { socket, settle });
      signal?.addEventListener("abort", abort, { once: true });
      socket.write(data, error => { if (error) settle(disconnected()); });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.emit("change");
    this.socket?.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
