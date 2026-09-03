import { AnthropicProvider } from './anthropic.js';
import { DeepSeekProvider } from './deepseek.js';
import type { Provider } from './types.js';

export * from './types.js';

/**
 * Models are commodity; the context layer is not. Switching providers must not change
 * what the rails guarantee — the safety story holds on the cheapest model available,
 * not only on the smartest.
 */
export function getProvider(name = process.env.MODEL_PROVIDER ?? 'anthropic'): Provider {
  switch (name) {
    case 'deepseek':
      return new DeepSeekProvider(process.env.DEEPSEEK_MODEL ?? 'deepseek-chat');
    case 'anthropic':
      return new AnthropicProvider();
    default:
      throw new Error(`unknown provider: ${name}`);
  }
}
