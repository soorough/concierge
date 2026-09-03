import { costCents, type ModelRequest, type ModelResponse, type Provider } from './types.js';

/**
 * OpenAI-compatible endpoint. Present so cost is a visible variable rather than a claim,
 * and so a slow provider is an env var away from being swapped.
 *
 * The interface is a swap point, not a guarantee of identical behaviour — JSON adherence
 * and latency differ, and per-provider prompt variants are what comes next.
 */
export class DeepSeekProvider implements Provider {
  readonly name = 'deepseek';
  readonly model: string;

  constructor(model = 'deepseek-chat') {
    this.model = model;
  }

  async call(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 700,
        temperature: req.temperature ?? 0.3,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n\n'),
          },
          ...req.messages,
        ],
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const usage = { input: json.usage.prompt_tokens, output: json.usage.completion_tokens };
    return {
      text: json.choices[0]?.message?.content ?? '',
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: costCents(usage, { inputPerMTok: 0.28, outputPerMTok: 0.42 }),
      model: this.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }
}
