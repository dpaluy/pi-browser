import { openai } from "./decision/openai.ts";
import { MODEL, typesafe } from "./decision/typesafe.ts";
import type { BrowserSettings } from "./settings.ts";

export interface DecisionModel {
  readonly label: string;
  ask(state: Record<string, string>, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer>>;
}

export type Question = { type: "choice"; instructions: string; options: string[] }
  | { type: "noul"; instructions: string; yes: string; no: string };
export type Answer = { probabilities?: Record<string, number>; noul?: number };

export type DecisionSettings = { provider: "typesafe"; model?: string; apiKeyEnv?: string }
  | { provider: "openai"; baseUrl: string; model: string; apiKeyEnv?: string };

export function decisionModel(settings: BrowserSettings, env: Record<string, string | undefined>): DecisionModel | undefined {
  const { decision } = settings;
  if (!decision) return env.TYPESAFE_API_KEY ? typesafe(MODEL, env.TYPESAFE_API_KEY) : undefined;
  const keyEnv = decision.apiKeyEnv ?? (decision.provider === "typesafe" ? "TYPESAFE_API_KEY" : undefined);
  const key = keyEnv === undefined ? undefined : env[keyEnv];
  if (keyEnv !== undefined && !key) throw new Error(`Set ${keyEnv} to use the ${decision.provider} decision model.`);
  return decision.provider === "openai" ? openai(decision.baseUrl, decision.model, key) : typesafe(decision.model ?? MODEL, key!);
}
