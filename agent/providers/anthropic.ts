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
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 700,
      temperature: req.temperature ?? 0.3,
      system: req.system,
      messages: req.messages,
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const pricing = PRICING[this.model] ?? { inputPerMTok: 1, outputPerMTok: 5 };
    return {
      text,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      costCents: costCents({ input: res.usage.input_tokens, output: res.usage.output_tokens }, pricing),
      model: this.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }
}
