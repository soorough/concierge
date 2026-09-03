import { getProvider } from './providers/index.js';

export type ExtractedFact = { predicate: string; object: string; confidence: number };

const SYSTEM = `You extract durable facts about a customer from a sales rep's free-text note.

Return a single JSON object: {"facts":[{"predicate":"...","object":"...","confidence":0.0}]}

Use these predicates only: prefers_style, budget_band, occasion, gifting, allergy, region,
household, purchase_history, contact_preference.

Rules:
- Record only what the note actually states. Never infer, never embellish.
- One fact per distinct claim. Keep "object" short — a few words.
- confidence reflects how explicit the note is: stated plainly 0.9, implied 0.5.
- If the note contains nothing durable, return {"facts":[]}.`;

/**
 * A rep's note is third-party evidence. It enters the same ledger as conversation facts
 * and is outranked by anything the customer says themselves.
 */
export async function extractFieldNoteFacts(note: string): Promise<ExtractedFact[]> {
  const provider = getProvider();
  const res = await provider.call({
    system: SYSTEM,
    messages: [{ role: 'user', content: note.slice(0, 4000) }],
    maxTokens: 500,
    temperature: 0,
  });
  const raw = res.text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1) return [];
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { facts?: ExtractedFact[] };
  return (parsed.facts ?? []).filter((f) => f?.predicate && f?.object);
}
