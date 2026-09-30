import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { config } from '../config.js';

/** USD per 1M tokens (input, output). Checked 2026-09 — keep docs/OPERATING_COSTS.md in sync. */
export const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
  local: [0, 0],
};
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const cost = (model: string, inTok: number, outTok: number) => {
  const [i, o] = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  return (inTok * i + outTok * o) / 1_000_000;
};

export interface GenResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  refused: boolean;
}

/** Counter used by tests to prove "AI OFF => no provider request". */
export const providerStats = { requests: 0 };

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  // API key lives only on the server (env). It is never sent to the browser.
  client ??= new Anthropic({ apiKey: config.anthropicApiKey, baseURL: config.anthropicBaseUrl, maxRetries: 1, timeout: 60_000 });
  return client;
}
export function resetClient() {
  client = null;
}

export async function anthropicAnswer(model: string, system: string, user: string): Promise<GenResult> {
  providerStats.requests++;
  const res = await anthropic().beta.messages.create({
    model,
    max_tokens: 4000,
    system,
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, model: res.model, refused: res.stop_reason === 'refusal' };
}

export async function anthropicStructured<T extends z.ZodType>(model: string, system: string, user: string, schema: T): Promise<{ data: z.infer<T> | null } & Omit<GenResult, 'text'>> {
  providerStats.requests++;
  const res = await anthropic().messages.parse({
    model,
    max_tokens: 8000,
    system,
    output_config: { effort: 'medium', format: zodOutputFormat(schema) },
    messages: [{ role: 'user', content: user }],
  });
  return {
    data: (res.parsed_output as z.infer<T> | null) ?? null,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    model: res.model,
    refused: res.stop_reason === 'refusal',
  };
}
