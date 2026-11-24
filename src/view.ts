import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { isElement } from "./jev.ts";

export function view(text: string, offset = 0, interactive = false): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Read offset must be a nonnegative integer.");
  if (offset > 0 && offset >= lines.length) {
    throw new Error(`Read offset ${offset} is past the end of the snapshot (${lines.length} lines).`);
  }
  const remaining = lines.slice(offset).map((line, i) => ({ line, index: offset + i }))
    .filter(({ line, index }) => !interactive || index === 0 || isElement(line));
  const page = truncateHead(remaining.map(({ line }) => line).join("\n"), {
    maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!page.truncated) return page.content;
  const shown = page.firstLineExceedsLimit ? 1 : page.outputLines;
  const last = remaining[shown - 1].index;
  const excerpt = page.firstLineExceedsLimit
    ? `[Line ${last + 1} exceeds the ${formatSize(DEFAULT_MAX_BYTES)} output limit.]` : page.content;
  return last + 1 < lines.length ? `${excerpt}\n\n[Output truncated; continue with offset ${last + 1}.]` : excerpt;
}
