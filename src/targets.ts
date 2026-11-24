import { isElement, locate, resolved, RESOLVE, verdict, type Hit, type Located } from "./jev.ts";

const percent = (score: number) => `${Math.round(score * 100)}%`;
const candidate = (lines: string[], hit: Hit) => `line ${hit.line + 1} (${percent(hit.score)}): ${lines[hit.line]}`;

export function formatFind(lines: string[], query: string, match: Located): string {
  return [`"${query}": ${verdict(match.exists)} (match ${percent(match.exists)}).`,
    ...match.hits.filter(hit => lines[hit.line] !== undefined).slice(0, 5).map(hit => candidate(lines, hit))].join("\n");
}

export function resolveTarget(lines: string[], target: string, match: Located): { ref: number; note: string } {
  const hits = match.hits.filter(hit => isElement(lines[hit.line] ?? ""));
  const best = resolved({ ...match, hits });
  if (best) {
    const line = lines[best.line].trimStart();
    return { ref: Number(/^\[(\d+)\]/.exec(line)![1]), note: `Matched "${target}" → ${line} (${percent(best.score)})` };
  }
  const [first, next] = hits;
  const likelihood = Math.max(match.ambiguous, first && next && next.score >= first.score * RESOLVE.ratio ? next.score : 0);
  const message = match.exists >= RESOLVE.exists && (match.ambiguous >= RESOLVE.ambiguous
    || (first && next && next.score >= first.score * RESOLVE.ratio))
    ? `"${target}" fits more than one element (${percent(likelihood)} likely), so nothing was done.`
    : `No element clearly matches "${target}" (match ${percent(match.exists)}), so nothing was done.`;
  throw new Error([message, ...hits.slice(0, 3).map(hit => candidate(lines, hit))].join("\n"));
}

export async function find(text: string, query: string, key: string, signal?: AbortSignal): Promise<string> {
  const lines = text.split("\n");
  const [match] = await locate(lines, [{ text: query, kind: "content" }], key, signal);
  return formatFind(lines, query, match);
}

export async function matchTargets(text: string, targets: string[], key: string, signal?: AbortSignal) {
  const lines = text.split("\n");
  const matches = await locate(lines, targets.map(text => ({ text, kind: "element" })), key, signal);
  return matches.map((match, index) => resolveTarget(lines, targets[index], match));
}
