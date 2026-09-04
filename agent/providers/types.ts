/** A tool the model may call, described the way every provider describes one. */
export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
};

/** The model asking for a tool. `id` is the provider's, and is replayed back verbatim. */
export type ToolUse = { id: string; name: string; input: Record<string, unknown> };

/** Our answer to one of those. */
export type ToolResult = { toolUseId: string; content: string; isError?: boolean };

export type ModelMessage = {
  role: 'user' | 'assistant';
  content: string;
  /** On an assistant turn that asked for tools, replayed so the provider can match ids. */
  toolUses?: ToolUse[];
  /** On the user turn that answers them. */
  toolResults?: ToolResult[];
};

export type SystemBlock = { text: string; cache?: boolean };

export type ModelRequest = {
  /** Ordered blocks; a block marked `cache` asks the provider to cache that prefix. */
  system: string | SystemBlock[];
  messages: ModelMessage[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Text to put in the assistant's mouth before it starts generating. Passing "{" makes a
   * JSON reply structurally the only option — refusals in particular tend to drop out of
   * a requested format and answer in prose instead.
   */
  prefill?: string;
  /**
   * Tools the model may call this request.
   *
   * Offering tools and prefilling are mutually exclusive in practice. Measured on Haiku
   * 4.5: with both, the model writes a half-formed JSON object *and* a tool call in the
   * same response, having been pulled in two directions. The turn loop therefore drops the
   * prefill whenever it offers tools, and the existing fence-stripping in
   * `parseModelOutput` covers the fenced JSON that comes back instead.
   */
  tools?: ToolSpec[];
};

export type ModelResponse = {
  text: string;
  /** Tools the model asked for. Empty unless it wants to call something. */
  toolUses: ToolUse[];
  /** Provider-neutral: 'tool_use' means it is waiting on us. */
  stopReason: 'tool_use' | 'end' | 'length' | 'other';
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
  /**
   * Whether this provider's tool calling is implemented and verified here.
   *
   * A provider that says no is not broken — the turn falls back to the single constrained
   * call, and every rail still runs. The safety story must hold on the cheapest model
   * available, so tool use is an enhancement to the path, never a precondition for it.
   */
  readonly supportsTools: boolean;
  call(req: ModelRequest): Promise<ModelResponse>;
}

/** Per-million-token prices, used to render a real cost-per-conversation figure. */
export type Pricing = { inputPerMTok: number; outputPerMTok: number };

export function costCents(usage: { input: number; output: number }, p: Pricing): number {
  return ((usage.input / 1e6) * p.inputPerMTok + (usage.output / 1e6) * p.outputPerMTok) * 100;
}
