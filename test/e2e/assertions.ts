import assert from "node:assert/strict";
import { readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { startBrowser } from "./harness.ts";
import type { fakePi } from "./pi.ts";

export const escapeRE = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function tabId(text: string, title: string, url: string) {
  const header = new RegExp(`^Tab (\\d+): ${escapeRE(title)} <${escapeRE(url)}>`, "m").exec(text);
  assert(header, `Expected tab header for ${title} at ${url}; got:\n${text}`);
  return Number(header[1]);
}

export function ref(text: string, role: string, name: string) {
  const line = new RegExp(`^ *\\[(\\d+)\\] ${escapeRE(role)} "${escapeRE(name)}"`, "m").exec(text);
  assert(line, `Missing ${role} ${JSON.stringify(name)} in:\n${text}`);
  return Number(line[1]);
}

type ToolOutput = Awaited<ReturnType<ReturnType<typeof fakePi>["call"]>>;
type Browser = Awaited<ReturnType<typeof startBrowser>>;

export async function image(t: TestContext, browser: Browser, url: string, result: ToolOutput, sample?: [number, number]) {
  assert.equal(result.images.length, 1, result.text);
  const [{ data, mimeType }] = result.images;
  assert.equal(mimeType, "image/jpeg");
  const jpeg = Buffer.from(data, "base64");
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], "JPEG start marker");
  const dir = await realpath(tmpdir());
  // On macOS the reported path can use either the symlinked or canonical temp root.
  const roots = [...new Set([tmpdir(), dir])].map(root => escapeRE(join(root, "pi-browser-"))).join("|");
  const file = new RegExp(`(?:${roots})[^\\s/]+/[^\\s]+?\\.jpe?g`, "i").exec(result.text)?.[0];
  assert(file, `No screenshot path in ${result.text}`);
  t.after(() => rm(dirname(file), { recursive: true, force: true }));
  assert.deepEqual(await readFile(file), jpeg, "Saved file matches the image content");
  const { width, height, rgb } = await browser.page<{ width: number; height: number; rgb?: number[] }>(url, `
    (async () => {
      const bitmap = await createImageBitmap(await (await fetch(${JSON.stringify(`data:${mimeType};base64,${data}`)})).blob());
      const { width, height } = bitmap;
      ${sample ? `const ctx = new OffscreenCanvas(width, height).getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const rgb = Array.from(ctx.getImageData(${sample.join(",")}, 1, 1).data).slice(0, 3);
      return { width, height, rgb };` : "return { width, height };"}
    })()
  `);
  assert(width > 0 && height > 0 && Math.max(width, height) <= 1568, `Long-edge cap: ${width}×${height}`);
  assert(width * height <= 1_150_000, `Area cap: ${width}×${height}`);
  assert.match(result.text, new RegExp(`${width}\\s*[×x]\\s*${height}`), "Reported image dimensions");
  return { width, height, rgb };
}
