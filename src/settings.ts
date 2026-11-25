import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { DecisionSettings } from "./decision.ts";

// A lock left by a Pi process that died mid-write is taken over after this long.
const STALE_LOCK_MS = 10_000;

export interface BrowserSettings {
  approveSites: boolean;
  alwaysAllow: string[];
  confirmEval: boolean;
  decision?: DecisionSettings;
}

function validateDecision(value: unknown, path: string): asserts value is DecisionSettings {
  const invalid = (message: string): never => { throw new Error(`Invalid browser settings: ${path}: decision ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("must be an object");
  const { provider, model, apiKeyEnv, baseUrl } = value as Record<string, unknown>;
  if (provider !== "typesafe" && provider !== "openai") return invalid(`has unknown provider ${JSON.stringify(provider)}; use typesafe or openai`);
  const fields = ["provider", "model", "apiKeyEnv", ...(provider === "openai" ? ["baseUrl"] : [])];
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) return invalid(`has unknown field ${field}; set credentials with apiKeyEnv`);
  }
  if ((provider === "openai" || model !== undefined) && (typeof model !== "string" || !model.trim())) {
    return invalid("model must be a non-empty string");
  }
  if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== "string" || !apiKeyEnv.trim())) {
    return invalid("apiKeyEnv must name an environment variable");
  }
  if (provider === "openai") {
    const url = typeof baseUrl === "string" ? URL.parse(baseUrl) : null;
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      return invalid("baseUrl must be an HTTP(S) base URL without credentials, a query, or a fragment");
    }
  }
}

export function settingsStore(dir: string) {
  const path = join(dir, "settings.json");
  const lockPath = `${path}.lock`;
  // Every Pi session, in this process or another, updates the file under one lock file.
  async function locked(write: () => Promise<void>): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        await (await open(lockPath, "wx", 0o600)).close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lock = await stat(lockPath).catch(() => undefined);
        if (lock && Date.now() - lock.mtimeMs > STALE_LOCK_MS) await rm(lockPath, { force: true });
        else await sleep(20);
      }
    }
    try {
      await write();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
  async function load(): Promise<BrowserSettings> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { approveSites: false, alwaysAllow: [], confirmEval: true };
      throw error;
    }
    const value: Partial<BrowserSettings> | null = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value.approveSites !== undefined && typeof value.approveSites !== "boolean")
      || (value.confirmEval !== undefined && typeof value.confirmEval !== "boolean")
      || (value.alwaysAllow !== undefined && (!Array.isArray(value.alwaysAllow) || !value.alwaysAllow.every(host => typeof host === "string")))) {
      throw new Error(`Invalid browser settings: ${path}`);
    }
    if (value.decision !== undefined) validateDecision(value.decision, path);
    return { approveSites: value.approveSites ?? false, alwaysAllow: value.alwaysAllow ?? [], confirmEval: value.confirmEval ?? true,
      ...(value.decision === undefined ? {} : { decision: value.decision }) };
  }
  function update(change: (settings: BrowserSettings) => void): Promise<void> {
    return locked(async () => {
      const settings = await load();
      change(settings);
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    });
  }
  return { load, update };
}

export type SettingsStore = ReturnType<typeof settingsStore>;
