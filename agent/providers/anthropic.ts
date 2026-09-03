import Anthropic from '@anthropic-ai/sdk';
import { costCents, type ModelRequest, type ModelResponse, type Provider, type Pricing } from './types.js';

const PRICING: Record<string, Pricing> = {
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
};

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
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
      messages: req.prefill
        ? [...req.messages, { role: 'assistant' as const, content: req.prefill }]
        : req.messages,
    });
    // The prefill is not echoed back, so it is restored to keep the text well-formed.
    const text =
      (req.prefill ?? '') +
      res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
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
      inputTokens: res.usage.input_tokens + cacheWrite + cacheRead,
      outputTokens: res.usage.output_tokens,
      costCents: cost,
      model: this.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }
}
