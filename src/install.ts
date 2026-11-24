import { statSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "dev.majesticlabs.pi_browser";
export const EXTENSION_ID = "odhaeafpfooplfbcefglfcmlpbedofdo";
export const EXTENSION_DIR = fileURLToPath(new URL("../extension", import.meta.url));
const relay = fileURLToPath(new URL("../host/relay.js", import.meta.url));

const macDirs = ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary",
  "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge", "Vivaldi"];
const linuxDirs = ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "google-chrome-canary",
  "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"];

export function detectBrowserDirs(home = homedir(), platform = process.platform): string[] {
  const base = platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
  const dirs = platform === "darwin" ? macDirs : platform === "linux" ? linuxDirs : [];
  return dirs.map(dir => join(base, dir)).filter(dir => statSync(dir, { throwIfNoEntry: false })?.isDirectory());
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export async function installHost(browserDirs: string[], socketsDir: string): Promise<string[]> {
  if (!process.versions.node || process.versions.bun || (await import("node:sea")).isSea()) {
    throw new Error("Pi Browser requires Pi to run on Node.js, not Bun or a standalone executable.");
  }
  await mkdir(socketsDir, { recursive: true, mode: 0o700 });
  await chmod(socketsDir, 0o700);
  const manifests: string[] = [];
  for (const browserDir of browserDirs) {
    const dir = resolve(browserDir, "NativeMessagingHosts");
    await mkdir(dir, { recursive: true });
    const launcher = join(dir, `${HOST_NAME}.sh`);
    const manifest = join(dir, `${HOST_NAME}.json`);
    await writeFile(launcher, `#!/bin/sh\nexec ${[process.execPath, relay, resolve(socketsDir)].map(quote).join(" ")}\n`, { mode: 0o700 });
    await chmod(launcher, 0o700);
    await writeFile(manifest, `${JSON.stringify({
      name: HOST_NAME,
      description: "Pi Browser native messaging host",
      path: launcher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    }, null, 2)}\n`, { mode: 0o644 });
    await chmod(manifest, 0o644);
    manifests.push(manifest);
  }
  return manifests;
}
