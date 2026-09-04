import Anthropic from '@anthropic-ai/sdk';
import {
  costCents,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type Pricing,
  type ToolUse,
} from './types.js';

const PRICING: Record<string, Pricing> = {
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
};

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly supportsTools = true;
  readonly model: string;
  private client: Anthropic;

  constructor(model = process.env.MODEL_NAME ?? 'claude-haiku-4-5-20251001') {
    this.model = model;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async call(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    /*
     * The system prompt carries the brand's whole catalog and is identical across every
     * turn for a brand, so it is marked cacheable. Showing the model the full catalog is
     * what makes semantic matching work; caching is what keeps it affordable.
     */
    /*
     * A turn that offered tools replays the exchange as content blocks, because the
     * provider matches a tool result to its call by id and a flat string cannot carry one.
     */
    const messages: Anthropic.MessageParam[] = req.messages.map((m) => {
      if (m.toolResults?.length) {
        return {
          role: 'user' as const,
          content: m.toolResults.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.toolUseId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
      }
      if (m.toolUses?.length) {
        return {
          role: 'assistant' as const,
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.toolUses.map((u) => ({
              type: 'tool_use' as const,
              id: u.id,
              name: u.name,
              input: u.input,
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 700,
      temperature: req.temperature ?? 0.3,
      system:
        typeof req.system === 'string'
          ? req.system
          : req.system.map((b) => ({
              type: 'text' as const,
              text: b.text,
              ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
            })),
      /*
       * Tools render ahead of the system prompt in the cached prefix, so the list must be
       * stable across a brand's turns or every turn pays a cache write.
       */
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      messages: req.prefill
        ? [...messages, { role: 'assistant' as const, content: req.prefill }]
        : messages,
    });
    // The prefill is not echoed back, so it is restored to keep the text well-formed.
    const text =
      (req.prefill ?? '') +
      res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    const toolUses: ToolUse[] = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    const pricing = PRICING[this.model] ?? { inputPerMTok: 1, outputPerMTok: 5 };
    const cacheWrite = res.usage.cache_creation_input_tokens ?? 0;
    const cacheRead = res.usage.cache_read_input_tokens ?? 0;
    // Cache writes cost 1.25x input, reads 0.1x. Counting them keeps the console's
    // cost-per-conversation figure honest rather than flattering.
    const cost =
      costCents({ input: res.usage.input_tokens, output: res.usage.output_tokens }, pricing) +
      costCents({ input: cacheWrite * 1.25 + cacheRead * 0.1, output: 0 }, pricing);
    return {
      text,
      toolUses,
      stopReason:
        res.stop_reason === 'tool_use'
          ? 'tool_use'
          : res.stop_reason === 'end_turn'
            ? 'end'
            : res.stop_reason === 'max_tokens'
              ? 'length'
              : 'other',
      inputTokens: res.usage.input_tokens + cacheWrite + cacheRead,
      outputTokens: res.usage.output_tokens,
      costCents: cost,
      model: this.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }
}
