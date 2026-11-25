import type { Answer, DecisionModel, Question } from "../decision.ts";

const CONCURRENCY = 4;

type Token = { token: string; logprob: number };
type Completion = { choices?: { message?: { content?: string | null }; logprobs?: { content?: (Token & { top_logprobs?: Token[] })[] } }[] };

function prompt(state: Record<string, string>, question: Question): string {
  const labels = question.type === "choice" ? new Map(question.options.map((id, i) => [id, i + 1])) : undefined;
  const context = Object.entries(state).map(([name, text]) => {
    // In line-indexed state, show the numeric labels alongside the corresponding lines.
    const annotated = labels ? text.replace(/^([^|\n]+)\|/gm, (prefix, id: string) =>
      labels.has(id) ? `Option ${labels.get(id)} (${id}) |` : prefix) : text;
    return `${name}:\n${annotated}`;
  }).join("\n\n");
  const format = question.type === "noul"
    ? `Choose one answer based strictly on the data above:\nno — ${question.no}\nyes — ${question.yes}\n\nYour answer (no or yes):`
    : `Allowed answers (number = option id):\n${question.options.map((id, i) => `${i + 1} = ${id}`).join("\n")}\nReturn only the number for the best option, without any other text.`;
  return `${context}\n\n${question.instructions}\n\n${format}`;
}

function validToken(value: Token): boolean {
  return typeof value?.token === "string" && Number.isFinite(value.logprob) && value.logprob <= 0;
}

export function openai(baseUrl: string, model: string, key?: string): DecisionModel {
  // Share the limit across all chunks and queries using this model.
  let active = 0;
  const waiting: (() => void)[] = [];
  const at = `The decision model at ${baseUrl} (${model})`;
  const missing = () => new Error(`${at} did not return token probabilities. Use a model and server that return logprobs, with thinking turned off.`);

  async function answer(state: Record<string, string>, question: Question, signal?: AbortSignal): Promise<Answer> {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
      body: JSON.stringify({
        model, messages: [{ role: "user", content: prompt(state, question) }], temperature: 0,
        logprobs: true, top_logprobs: 20, max_tokens: question.type === "noul" ? 1 : 4,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`${at} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const choice = (await response.json() as Completion)?.choices?.[0];
    const tokens = choice?.logprobs?.content;
    if (!Array.isArray(tokens) || !tokens.length || !tokens.every(validToken)) throw missing();
    const content = choice?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    const invalid = () => new Error(`${at} returned ${JSON.stringify(content ?? null)} instead of ${question.type === "noul" ? "yes or no" : "a valid option label"}. Use a model with thinking turned off.`);
    if (question.type === "noul") {
      const normalized = (token: string) => token.trim().toLowerCase();
      if (!["yes", "no"].includes(normalized(text))) throw invalid();
      const top = tokens[0].top_logprobs;
      if (!Array.isArray(top) || !top.every(validToken)) throw missing();
      let yes = 0, no = 0;
      for (const { token, logprob } of top) {
        if (normalized(token) === "yes") yes += Math.exp(logprob);
        if (normalized(token) === "no") no += Math.exp(logprob);
      }
      if (!yes && !no) throw missing();
      return { noul: yes / (yes + no) };
    }
    const id = question.options[Number(text) - 1];
    if (!/^[1-9]\d*$/.test(text) || id === undefined) throw invalid();
    let label = "", logprob = 0;
    for (const token of tokens) {
      const part = label ? token.token : token.token.trimStart();
      if (!label && !part) continue;
      const digits = /^\d*/.exec(part)![0];
      if (digits) {
        label += digits;
        logprob += token.logprob;
      }
      if (digits !== part) break;
    }
    if (label !== text) throw invalid();
    return { probabilities: { [id]: Math.exp(logprob) } };
  }

  return {
    label: `${model} at ${baseUrl}`,
    async ask(state, questions, signal) {
      return Object.fromEntries(await Promise.all(Object.entries(questions).map(async ([id, question]) => {
        if (active < CONCURRENCY) active++;
        else await new Promise<void>(resolve => waiting.push(resolve));
        try {
          signal?.throwIfAborted();
          return [id, await answer(state, question, signal)];
        } finally {
          const next = waiting.shift();
          if (next) next();
          else active--;
        }
      })));
    },
  };
}
