import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { settingsStore } from "../src/settings.ts";

const run = promisify(execFile);
const settingsModule = fileURLToPath(new URL("../src/settings.ts", import.meta.url));

async function folder(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("concurrent updates from separate Pi processes all persist", async t => {
  const dir = await folder(t);
  // Each child is a separate Pi process adding its own hosts while the others write.
  const child = (name: string) => run(process.execPath, ["--input-type=module", "-e", `
    const { settingsStore } = await import(${JSON.stringify(settingsModule)});
    const store = settingsStore(${JSON.stringify(dir)});
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.update(s => { s.alwaysAllow.push("${name}" + i + ".test"); })));
  `]);
  const local = settingsStore(dir);
  await Promise.all([child("a"), child("b"), child("c"), local.update(s => { s.confirmEval = false; })]);
  const settings = await local.load();
  assert.equal(settings.confirmEval, false);
  assert.equal(settings.alwaysAllow.length, 30);
  assert.deepEqual(new Set(settings.alwaysAllow).size, 30);
});

test("a lock left by a crashed process is taken over; a fresh one is waited for", async t => {
  const dir = await folder(t);
  const store = settingsStore(dir);
  const lock = join(dir, "settings.json.lock");

  await writeFile(lock, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await store.update(s => { s.alwaysAllow.push("stale.test"); });
  assert.deepEqual((await store.load()).alwaysAllow, ["stale.test"]);

  await writeFile(lock, "");
  let done = false;
  const pending = store.update(s => { s.alwaysAllow.push("fresh.test"); }).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(done, false, "update must wait while another process holds the lock");
  await rm(lock);
  await pending;
  assert.deepEqual(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).alwaysAllow, ["stale.test", "fresh.test"]);
});

test("settings validate the decision provider and preserve it during updates", async t => {
  const dir = await folder(t);
  const store = settingsStore(dir);
  const path = join(dir, "settings.json");
  for (const [decision, error] of [
    [null, /decision must be an object/],
    [{ provider: "unknown" }, /decision has unknown provider "unknown"/],
    [{ provider: "typesafe", model: 42 }, /decision model must be a non-empty string/],
    [{ provider: "typesafe", apiKeyEnv: " " }, /decision apiKeyEnv must name an environment variable/],
    [{ provider: "typesafe", apiKey: "secret" }, /decision has unknown field apiKey/],
    [{ provider: "openai", baseUrl: "http://127.0.0.1/v1" }, /decision model must be a non-empty string/],
    [{ provider: "openai", model: "local", baseUrl: "ftp://example.test" }, /decision baseUrl must be an HTTP\(S\) base URL/],
    [{ provider: "openai", model: "local", baseUrl: "https://user:secret@example.test" }, /decision baseUrl must be an HTTP\(S\) base URL/],
  ] as const) {
    await writeFile(path, JSON.stringify({ decision }));
    await assert.rejects(store.load(), error);
  }
  const decision = { provider: "openai", model: "local", baseUrl: "http://127.0.0.1:8080/v1", apiKeyEnv: "LOCAL_KEY" };
  await writeFile(path, JSON.stringify({ decision }));
  await store.update(s => { s.confirmEval = false; });
  assert.deepEqual(await store.load(), { approveSites: false, alwaysAllow: [], confirmEval: false, decision });
});
