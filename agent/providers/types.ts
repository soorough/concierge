export type ModelMessage = { role: 'user' | 'assistant'; content: string };

export type ModelRequest = {
  system: string;
  messages: ModelMessage[];
  maxTokens?: number;
  temperature?: number;
};

export type ModelResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  model: string;
  provider: string;
  latencyMs: number;
};

export interface Provider {
  readonly name: string;
  readonly model: string;
  call(req: ModelRequest): Promise<ModelResponse>;
}

/** Per-million-token prices, used to render a real cost-per-conversation figure. */
export type Pricing = { inputPerMTok: number; outputPerMTok: number };

export function costCents(usage: { input: number; output: number }, p: Pricing): number {
  return ((usage.input / 1e6) * p.inputPerMTok + (usage.output / 1e6) * p.outputPerMTok) * 100;
}
