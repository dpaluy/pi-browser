import { readdirSync, watch } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";

const PROTOCOL = 1;
const MAX_INCOMING_BYTES = 64 * 1024 * 1024; // Chrome native messaging limit (browser to host).
const dir = process.argv[2];
const sockets = new Map();
let watcher;
let timer;
let ready = false;
let stopping = false;

function send(message) {
  const bytes = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return process.stdout.write(Buffer.concat([header, bytes]));
}

function stop(error) {
  if (stopping) return;
  stopping = true;
  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
  watcher?.close();
  clearInterval(timer);
  for (const socket of sockets.values()) socket.destroy();
  process.stdin.destroy();
}

function scan() {
  if (stopping) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") stop(error.message);
    return;
  }
  for (const entry of entries) {
    if (!entry.isSocket() || !entry.name.endsWith(".sock")) continue;
    const session = basename(entry.name, ".sock");
    if (sockets.has(session)) continue;
    const socket = createConnection(join(dir, entry.name));
    sockets.set(session, socket);
    let opened = false;
    let pending = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      opened = true;
      if (!send({ session, open: true })) pauseSocket(socket);
    });
    socket.on("data", chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch {
          console.error(`Invalid JSON from Pi socket ${session}.`);
          socket.destroy();
          return;
        }
        if (!send({ session, message })) pauseSocket(socket);
      }
    });
    socket.on("error", error => {
      if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") console.error(error.message);
    });
    socket.once("close", () => {
      paused.delete(socket);
      sockets.delete(session);
      if (opened && !stopping) send({ session, open: false });
    });
  }
}

const paused = new Set();
function pauseSocket(socket) {
  socket.pause();
  paused.add(socket);
}
process.stdout.on("drain", () => {
  for (const socket of paused) socket.resume();
  paused.clear();
});

function receive(message) {
  if (!ready) {
    const version = message?.hello?.protocol;
    if (version !== PROTOCOL) {
      const error = `Pi Browser protocol mismatch (relay ${PROTOCOL}, extension ${String(version)}). Reload the extension in chrome://extensions and run /reload in Pi.`;
      send({ error: { message: error } });
      stop(error);
      return;
    }
    ready = true;
    send({ hello: { protocol: PROTOCOL, relay: "0.2.2" } });
    try {
      watcher = watch(dir, scan).on("error", error => stop(error.message));
    } catch (error) {
      if (error.code !== "ENOENT") { stop(error.message); return; }
    }
    timer = setInterval(scan, 2000);
    scan();
    return;
  }
  if (typeof message?.session !== "string" || !message.message || typeof message.message !== "object") return;
  sockets.get(message.session)?.write(`${JSON.stringify(message.message)}\n`);
}

const header = Buffer.alloc(4);
let offset = 0;
let frame = header;
process.stdin.on("data", chunk => {
  let start = 0;
  while (!stopping && start < chunk.length) {
    const length = Math.min(frame.length - offset, chunk.length - start);
    chunk.copy(frame, offset, start, start + length);
    start += length;
    offset += length;
    if (offset < frame.length) continue;
    offset = 0;
    if (frame === header) {
      const size = header.readUInt32LE();
      if (!size || size > MAX_INCOMING_BYTES) { stop("Invalid native messaging frame length."); return; }
      frame = Buffer.allocUnsafe(size);
    } else {
      let message;
      try { message = JSON.parse(frame.toString("utf8")); } catch { stop("Invalid native messaging JSON."); return; }
      frame = header;
      receive(message);
    }
  }
});
process.stdin.on("end", () => stop());
process.stdin.on("error", error => stop(error.message));
process.stdout.on("error", error => stop(error.message));
if (!dir) stop("Usage: node relay.js <socketsDir>");
