import type { Answer, DecisionModel } from "../decision.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";
const TIMEOUT_MS = 30_000;

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

export function typesafe(model: string, key: string): DecisionModel {
  return {
    label: `TypeSafe ${model}`,
    ask(state, questions, signal) {
      return post({
        model,
        state,
        questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, {
          type: question.type,
          instructions: question.instructions,
          criteria: question.type === "choice" ? Object.fromEntries(question.options.map(option => [option, null]))
            : { true: question.yes, false: question.no },
        }])),
      }, key, signal);
    },
  };
}
