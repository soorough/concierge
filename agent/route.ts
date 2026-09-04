/**
 * Whether this turn should be offered tools at all.
 *
 * The brief's instruction is to keep the single constrained call for turns that need no
 * live data, which is most of them. "What goes with a ribeye" is reasoning over a catalog
 * that is already in the prompt; there is nothing to look up and nothing to commit to.
 *
 * There is a second reason to route, which is not about cost. Offering tools means dropping
 * the `{` prefill — the two cannot be combined, and the measurement is in
 * `providers/types.ts`. The prefill is what makes a JSON reply structurally the only
 * option, and refusals in particular tend to drop out of a requested format when it is only
 * asked for. So a turn that gains nothing from tools should not pay for them in output
 * discipline either.
 *
 * Deterministic and inspectable on purpose, in the same spirit as the pre-model rails: a
 * classifier here would be a second model call to decide whether to make model calls.
 */

/** Asking what something costs, or reasoning about money. */
const PRICE_INTENT =
  /\b(price|prices|pricing|cost|costs|how much|cheap|cheapest|expensive|afford|budget|under|over|less than|more than|between)\b|[$£€₹]\s?\d/i;

/** Asking whether it can be bought, which is a question about now. */
const STOCK_INTENT =
  /\b(in stock|out of stock|sold out|available|availability|do you have|still have|any left|restock|back in)\b/i;

/** Reaching for policy text that retrieval deliberately does not carry. */
const TERMS_INTENT =
  /\b(terms|conditions|t&c|legal|warranty|guarantee|subscription|subscribe|auto[- ]?ship|recurring|cancel|privacy|liability|arbitration|dispute)\b/i;

/** Language that commits — the customer is buying, not browsing. */
const COMMIT_INTENT =
  /\b(add|buy|order|purchase|checkout|check out|take it|i'?ll take|get me|send me|ship me)\b/i;

export type Route = {
  useTools: boolean;
  /** Named so the console can say why a turn cost what it did. */
  reason: string;
};

export function routeTurn(opts: { message: string; cartLines: number }): Route {
  if (PRICE_INTENT.test(opts.message)) return { useTools: true, reason: 'price intent' };
  if (STOCK_INTENT.test(opts.message)) return { useTools: true, reason: 'availability intent' };
  if (TERMS_INTENT.test(opts.message)) return { useTools: true, reason: 'terms intent' };
  if (COMMIT_INTENT.test(opts.message)) return { useTools: true, reason: 'commit intent' };
  if (opts.cartLines > 0) return { useTools: true, reason: 'an open cart is a commitment' };
  return { useTools: false, reason: 'no live data needed' };
}
