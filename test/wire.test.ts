import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { detectBrowserDirs, EXTENSION_ID, HOST_NAME, installHost } from "../src/install.ts";
import { SessionServer } from "../src/server.ts";

const relay = fileURLToPath(new URL("../host/relay.js", import.meta.url));
const config = { timeout: 7000 };

async function temp(t: TestContext) {
  const dir = await mkdtemp("/tmp/pibr-wire-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const frame = (packet: object) => {
  const body = Buffer.from(JSON.stringify(packet));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
async function* frames(stdout: Readable) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stdout) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const end = 4 + buffer.readUInt32LE();
      if (buffer.length < end) break;
      yield JSON.parse(buffer.subarray(4, end).toString());
      buffer = buffer.subarray(end);
    }
  }
  assert.equal(buffer.length, 0, "Truncated native frame");
}

async function socketEndpoint(t: TestContext, dir: string, label: string) {
  let socket: Socket | undefined;
  const server = createServer().listen(join(dir, `${label}.sock`));
  const incoming = once(server, "connection").then(([peer]) => (socket = peer as Socket));
  t.after(() => { socket?.destroy(); server.close(); });
  await once(server, "listening");
  return incoming;
}

function lines(socket: Socket) {
  const reader = createInterface({ input: socket })[Symbol.asyncIterator]();
  return async () => {
    const result = await reader.next();
    return result.done ? undefined : JSON.parse(result.value);
  };
}

test("relay frames split and bundled messages, labels by socket, and closes on stdin EOF", config, async t => {
  const dir = await temp(t);
  const alpha = socketEndpoint(t, dir, "alpha");
  const beta = socketEndpoint(t, dir, "beta");
  const child = spawn(process.execPath, [relay, dir]);
  t.after(() => { child.kill(); });
  const exited = once(child, "close");
  const out = frames(child.stdout);
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk; });
  const hello = frame({ hello: { protocol: 1 } });
  child.stdin.write(hello.subarray(0, 2));
  child.stdin.write(hello.subarray(2, 10));
  child.stdin.write(hello.subarray(10));
  assert.deepEqual((await out.next()).value, { hello: { protocol: 1, relay: "0.2.0" } });
  const announced = [(await out.next()).value, (await out.next()).value];
  assert.deepEqual(announced.sort((a, b) => a.session.localeCompare(b.session)), [{ session: "alpha", open: true }, { session: "beta", open: true }]);
  const a = await alpha, b = await beta;
  const fromA = lines(a), fromB = lines(b);
  const payload = { text: "cafè 🍵", session: "not-alpha" };
  const input = frame({ session: "alpha", message: payload });
  const unicode = input.indexOf(Buffer.from("🍵"));
  assert(unicode > 0);
  child.stdin.write(input.subarray(0, unicode + 1));
  child.stdin.write(Buffer.concat([input.subarray(unicode + 1), frame({ session: "beta", message: { id: 8 } })]));
  assert.deepEqual(await fromA(), payload);
  assert.deepEqual(await fromB(), { id: 8 });
  a.write('{"session":"beta",');
  a.write('"text":"α"}\n{"id":2}\n');
  assert.deepEqual((await out.next()).value, { session: "alpha", message: { session: "beta", text: "α" } });
  assert.deepEqual((await out.next()).value, { session: "alpha", message: { id: 2 } });
  a.end();
  assert.deepEqual((await out.next()).value, { session: "alpha", open: false });
  const bClosed = once(b, "close");
  child.stdin.end();
  await bClosed;
  assert.equal((await exited)[0], 0, diagnostics);
  assert.equal(diagnostics, "");
});

test("relay refuses a protocol mismatch and reports both versions and reload steps", config, async t => {
  const child = spawn(process.execPath, [relay, await temp(t)]);
  t.after(() => { child.kill(); });
  const exited = once(child, "close");
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk; });
  child.stdin.write(frame({ hello: { protocol: 7 } }));
  const out = frames(child.stdout);
  const packet = (await out.next()).value;
  assert.match(packet.error.message, /relay 1, extension 7.*chrome:\/\/extensions.*\/reload/);
  assert.equal((await out.next()).done, true);
  assert.equal((await exited)[0], 1);
  assert.match(diagnostics, /protocol mismatch/);
});

test("Pi socket refuses another browser and closes/unlinks at shutdown", config, async t => {
  const dir = join(await temp(t), "sockets");
  let name = "Initial";
  const server = await SessionServer.open(dir, "test", () => name);
  t.after(() => server.close());
  const path = join(dir, "test.sock");
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  const entry = await lstat(path);
  assert(entry.isSocket());
  assert.equal(entry.mode & 0o777, 0o600);
  const primary = createConnection(path);
  t.after(() => { primary.destroy(); });
  const messages = lines(primary);
  primary.write('{"hello":{"protocol":1,"extension":"0.1.0","browser":"Chrome/141.0"}}\n');
  await server.connect(1000);
  assert.deepEqual(await messages(), { hello: { protocol: 1, session: "test", name: "Initial" } });
  const second = createConnection(path);
  t.after(() => { second.destroy(); });
  const refused = lines(second);
  assert.deepEqual(await refused(), { refused: "another browser profile is connected" });
  assert.equal(await refused(), undefined);
  name = "Renamed";
  const request = server.request("read", { tabId: 12 }, ["example.com"], 500);
  assert.deepEqual(await messages(), { id: 1, method: "read", params: { tabId: 12 }, allowed: ["example.com"], name });
  primary.write('{"id":1,"result":{"text":"Hello"}}\n');
  assert.deepEqual(await request, { text: "Hello" });
  await assert.rejects(server.request("status", {}, [], 20), /status request timed out after 0\.02 s/);
  const closing = assert.rejects(server.request("read", {}, [], 1000), /disconnected/);
  await server.close();
  await closing;
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("Pi socket rejects mismatched handshakes with actionable versions", config, async t => {
  const dir = await temp(t);
  const server = await SessionServer.open(dir, "mismatch", () => "Test");
  t.after(() => server.close());
  const peer = createConnection(join(dir, "mismatch.sock"));
  t.after(() => { peer.destroy(); });
  const messages = lines(peer);
  const expected = /Pi 1, extension 7.*chrome:\/\/extensions.*\/reload/;
  const connection = assert.rejects(server.connect(1000), expected);
  peer.write('{"hello":{"protocol":7,"extension":"7.0.0","browser":"Chrome"}}\n');
  assert.match((await messages()).error.message, expected);
  assert.equal(await messages(), undefined);
  await connection;
});

test("Pi status follows the extension being turned off and on", config, async t => {
  const dir = await temp(t);
  const server = await SessionServer.open(dir, "toggle", () => "Test");
  t.after(() => server.close());
  const peer = createConnection(join(dir, "toggle.sock"));
  t.after(() => { peer.destroy(); });
  const messages = lines(peer);
  peer.write('{"hello":{"protocol":1,"extension":"0.1.0","browser":"Chrome/158","on":false}}\n');
  await server.connect(1000);
  assert.equal((await messages()).hello.session, "toggle");
  assert.equal(server.status, "Connected to Chrome/158, but Pi Browser is turned off in the browser. Click its toolbar icon to turn it on.");
  peer.write('{"state":{"on":true}}\n');
  await waitFor(() => server.status === "Connected to Chrome/158 (extension 0.1.0).");
  peer.write('{"state":{"on":false}}\n');
  await waitFor(() => /turned off/.test(server.status));
});

async function waitFor(check: () => boolean) {
  while (!check()) await new Promise(resolve => setTimeout(resolve, 10));
}

test("install discovers profile dirs, writes an exclusive manifest and a runnable quoted launcher", config, async t => {
  const home = await temp(t);
  const chrome = join(home, "Library", "Application Support", "Google", "Chrome");
  const brave = join(home, ".config", "BraveSoftware", "Brave-Browser");
  const sockets = join(home, "it's a socket dir");
  await mkdir(chrome, { recursive: true });
  await mkdir(brave, { recursive: true });
  assert.deepEqual(detectBrowserDirs(home, "darwin"), [chrome]);
  assert.deepEqual(detectBrowserDirs(home, "linux"), [brave]);
  assert.deepEqual(detectBrowserDirs(home, "win32"), []);
  const manifests = await installHost([chrome, brave], sockets);
  for (const [manifest, dir] of manifests.map((file, i) => [file, [chrome, brave][i]])) {
    const native = join(dir, "NativeMessagingHosts");
    const launcher = join(native, `${HOST_NAME}.sh`);
    assert.equal(manifest, join(native, `${HOST_NAME}.json`));
    assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), {
      name: HOST_NAME, description: "Pi Browser native messaging host", type: "stdio", path: launcher,
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    assert.equal((await lstat(manifest)).mode & 0o777, 0o644);
    assert.equal((await lstat(launcher)).mode & 0o777, 0o700);
    const program = await readFile(launcher, "utf8");
    assert(program.startsWith(`#!/bin/sh\nexec '${process.execPath}' '${relay}' `));
    assert(program.endsWith(`${sockets.replace("'", "'\\''")}'\n`));
  }
  assert.equal((await lstat(sockets)).mode & 0o777, 0o700);
  const peer = socketEndpoint(t, sockets, "launcher");
  const child = spawn(join(brave, "NativeMessagingHosts", `${HOST_NAME}.sh`));
  t.after(() => { child.kill(); });
  const exited = once(child, "close");
  const out = frames(child.stdout);
  child.stdin.write(frame({ hello: { protocol: 1 } }));
  assert.deepEqual((await out.next()).value, { hello: { protocol: 1, relay: "0.2.0" } });
  assert.deepEqual((await out.next()).value, { session: "launcher", open: true });
  await peer;
  child.stdin.end();
  assert.equal((await exited)[0], 0);
});
