// Semantic lookup over a page snapshot with TypeSafe's Jev (https://docs.typesafe.ai/api).
// Each line of the snapshot gets an id; one Choice question per query ranks the candidate lines,
// a companion Noul question says whether any line matches at all, since Choice
// probabilities always sum to 1 (https://docs.typesafe.ai/patterns/companion-noul), and for elements
// a second Noul says whether the description fits several, since Choice puts its peak on one of equals.

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";
// A Choice question takes at most 255 options; Jev reads 32k tokens per question by default.
export const MAX_OPTIONS = 250;
export const MAX_CHUNK_BYTES = 40_000;
const LINE_CHARS = 300;
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

export interface Query {
  text: string;
  // element: options are the lines with a [ref]; content: options are every line.
  kind: "element" | "content";
}

export interface Hit {
  line: number;
  // Probability of this line among its chunk's options, times the chunk's match probability.
  score: number;
  probability: number;
  // The ambiguity answer of this line's chunk.
  ambiguous: number;
}

export interface Located {
  exists: number;
  // Element queries: probability the description fits two or more elements about equally well, in the best hit's chunk.
  ambiguous: number;
  hits: Hit[];
}

export interface Chunk {
  start: number;
  end: number;
}

export const isElement = (line: string) => /^\s*\[\d+\] /.test(line);

function compact(line: string): string {
  const indent = line.length - line.trimStart().length;
  const text = line.trimStart();
  return `${" ".repeat(Math.ceil(indent / 2))}${text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}…` : text}`;
}

const id = (line: number) => `L${line}`;

// Splits lines into consecutive chunks, each with at most MAX_OPTIONS candidates and MAX_CHUNK_BYTES of text.
export function chunks(lines: string[], candidate: (line: string) => boolean, maxOptions = MAX_OPTIONS, maxBytes = MAX_CHUNK_BYTES): Chunk[] {
  const result: Chunk[] = [];
  let start = 0, options = 0, bytes = 0;
  for (let line = 0; line < lines.length; line++) {
    const size = Buffer.byteLength(`${id(line)}| ${compact(lines[line])}\n`);
    const option = candidate(lines[line]) ? 1 : 0;
    if (line > start && (options + option > maxOptions || bytes + size > maxBytes)) {
      result.push({ start, end: line });
      start = line;
      options = 0;
      bytes = 0;
    }
    options += option;
    bytes += size;
  }
  if (lines.length > start) result.push({ start, end: lines.length });
  return result;
}

function questions(query: Query, index: number, options: string[]): Record<string, unknown> {
  const element = query.kind === "element";
  return {
    [`where${index}`]: {
      type: "choice",
      instructions: element
        ? `\`page\` is a web page's accessibility tree, one line per id; lines with a [number] are elements a user can act on. Which element should be used for: "${query.text}"?`
        : `\`page\` is a web page's accessibility tree, one line per id. Which line best answers or matches: "${query.text}"?`,
      criteria: Object.fromEntries(options.map(option => [option, null])),
    },
    [`exists${index}`]: {
      type: "noul",
      instructions: element
        ? `\`page\` is a web page's accessibility tree; lines with a [number] are elements a user can act on. Does \`page\` include such an element that fits: "${query.text}"?`
        : `\`page\` is a web page's accessibility tree. Does any line of \`page\` answer or match: "${query.text}"?`,
      criteria: element
        ? { true: "A line with a [number] is clearly the element described", false: "No line with a [number] is the element described" }
        : { true: "At least one line states, shows, or directly matches it", false: "No line addresses it" },
    },
    ...(element ? {
      [`ambiguous${index}`]: {
        type: "noul",
        instructions: `\`page\` is a web page's accessibility tree; lines with a [number] are elements a user can act on. Could "${query.text}" reasonably mean two or more different elements in \`page\`?`,
        criteria: { true: "Two or more [number] lines fit the description about equally well, so it is unclear which one is meant", false: "At most one [number] line fits; the description singles it out" },
      },
    } : {}),
  };
}

interface Answer {
  noul?: number;
  probabilities?: Record<string, number>;
}

async function post(body: unknown, key: string, signal?: AbortSignal, retried = false): Promise<Record<string, Answer>> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 429 && !retried) {
    const wait = Math.min(Number(response.headers.get("retry-after")) || 1, 10);
    await new Promise(resolve => setTimeout(resolve, wait * 1000));
    return post(body, key, signal, true);
  }
  if (!response.ok) throw new Error(`TypeSafe answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json() as { answers: Record<string, Answer> }).answers;
}

async function pool<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

// Ranks the snapshot's lines for each query. lines[0] is the tab's header line.
export async function locate(lines: string[], queries: Query[], key: string, signal?: AbortSignal): Promise<Located[]> {
  const [header, ...body] = lines;
  const kinds = [...new Set(queries.map(query => query.kind))];
  const candidate = (line: string) => kinds.includes("content") ? line.trim() !== "" : isElement(line);
  const parts = chunks(body, candidate);
  const results: Located[] = queries.map(() => ({ exists: 0, ambiguous: 0, hits: [] }));
  await pool(parts, async ({ start, end }) => {
    const page = body.slice(start, end).map((line, offset) => `${id(start + offset + 1)}| ${compact(line)}`).join("\n");
    const asked = queries.map((query, index) => {
      const options = body.slice(start, end).flatMap((line, offset) => (query.kind === "element" ? isElement(line) : line.trim() !== "") ? [id(start + offset + 1)] : []);
      return { query, index, options };
    }).filter(({ options }) => options.length);
    if (!asked.length) return;
    const answers = await post({
      model: MODEL,
      state: { tab: header, page },
      questions: Object.assign({}, ...asked.map(({ query, index, options }) => questions(query, index, options))),
    }, key, signal);
    for (const { index } of asked) {
      const exists = answers[`exists${index}`]?.noul ?? 0;
      const result = results[index];
      result.exists = Math.max(result.exists, exists);
      const ambiguous = answers[`ambiguous${index}`]?.noul ?? 0;
      for (const [option, probability] of Object.entries(answers[`where${index}`]?.probabilities ?? {})) {
        result.hits.push({ line: Number(option.slice(1)), probability, score: probability * exists, ambiguous });
      }
    }
  });
  for (const result of results) {
    result.hits.sort((a, b) => b.score - a.score);
    result.ambiguous = result.hits[0]?.ambiguous ?? 0;
  }
  return results;
}

// An element query resolves only when one element clearly wins: the page has a match, the description does not fit
// several, the winner holds most of its chunk's probability, and the runner-up, from any chunk, scores under half of it.
export const RESOLVE = { exists: 0.6, ambiguous: 0.5, probability: 0.7, ratio: 0.5 };

export function resolved({ exists, ambiguous, hits }: Located): Hit | undefined {
  const [best, next] = hits;
  if (!best || exists < RESOLVE.exists || ambiguous >= RESOLVE.ambiguous || best.probability < RESOLVE.probability) return undefined;
  if (next && next.score >= best.score * RESOLVE.ratio) return undefined;
  return best;
}

export function verdict(exists: number): string {
  return exists >= 0.7 ? "found on this page" : exists < 0.35 ? "probably not on this page" : "partly matched";
}
