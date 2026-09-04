import { resolvePrice, checkAvailability, searchPolicy } from './tools.js';
import type { RetrievedProduct } from './retrieve.js';
import type { StoredBrand } from '../store/queries.js';
import type { ToolSpec, ToolUse } from './providers/types.js';

/**
 * The tools the model may call, and what happens when it does.
 *
 * `agent/tools.ts` is the callable surface; this is the part of it the model is shown.
 * The two are deliberately not the same set.
 *
 * Every tool here can tell the model something the prompt does not already contain. That
 * is the whole admission test, and it is what keeps a call budget meaningful:
 *
 *   - `resolve_price` and `check_availability` reach the live store. The catalog in the
 *     prompt is the ingest snapshot, so these are the only way to know what is true now.
 *   - `search_policy` reaches the `terms` corpus, which retrieval excludes from the text
 *     carried on every turn because it is half the policy text and almost all boilerplate.
 *
 * Two tools that exist in `tools.ts` are deliberately **not** offered:
 *
 *   - `read_facts` would return what the prompt already lists. A tool that repeats the
 *     prompt spends the budget to learn nothing.
 *   - `write_cart` is a side effect, and side effects happen after the rails have judged
 *     the reply, never during. A cart the model wrote mid-loop would never be seen by
 *     `CART_MISMATCH` or `CART_UNANNOUNCED`, which exist precisely to catch a cart that
 *     disagrees with what the customer was told. The model asks for a cart the way it
 *     always has, in `actions`, and the loop writes it once the rails have passed.
 */

/** Products are addressed the way they are everywhere else: catalog number or SKU. */
const REF_SCHEMA = {
  type: 'object',
  properties: {
    ref: {
      type: 'string',
      description: 'The catalog number shown beside the product, or its SKU. Never a title.',
    },
  },
  required: ['ref'],
  additionalProperties: false,
} as const;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'resolve_price',
    description:
      "Ask the brand's live store what a product costs right now. The catalog you were " +
      'given is a snapshot taken when the brand was ingested, so use this before reasoning ' +
      'about a price that must be current — a budget, a comparison, or a ranking. You still ' +
      'write {{price:REF}} in your reply; this is for your own reasoning.',
    inputSchema: REF_SCHEMA as unknown as Record<string, unknown>,
  },
  {
    name: 'check_availability',
    description:
      "Ask the brand's live store whether a product can be bought today. The catalog's " +
      'availability is from ingest time. Use this before recommending something the ' +
      'customer intends to buy now.',
    inputSchema: REF_SCHEMA as unknown as Record<string, unknown>,
  },
  {
    name: 'search_policy',
    description:
      "Search the brand's full policy text, including terms and conditions, which are not " +
      'included in what you were given. Use this for questions about legal terms, ' +
      'subscriptions, warranties or anything the policy text above does not answer.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in the customer\'s own words.' },
      },
      required: ['query'],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
  },
];

export type ExecutedTool = {
  toolUseId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Fed back to the model. */
  content: string;
  source: string;
  ok: boolean;
  ms: number;
};

/**
 * Run one tool the model asked for.
 *
 * A bad reference is answered, not thrown. The model asking for a product it was never
 * shown is a thing that happens, and telling it so is more useful than failing the turn —
 * it can correct itself on the next pass, inside the same budget.
 */
export async function executeTool(
  use: ToolUse,
  ctx: { brand: StoredBrand; index: Map<string, RetrievedProduct> },
): Promise<ExecutedTool> {
  const started = Date.now();
  const args = use.input ?? {};
  const fail = (content: string): ExecutedTool => ({
    toolUseId: use.id,
    tool: use.name,
    args,
    content,
    source: 'local',
    ok: false,
    ms: Date.now() - started,
  });

  const product = (): RetrievedProduct | undefined =>
    ctx.index.get(String(args.ref ?? '').trim().toLowerCase());

  switch (use.name) {
    case 'resolve_price': {
      const p = product();
      if (!p) return fail(`No product with reference "${args.ref}". Use a catalog number you were shown.`);
      const r = await resolvePrice({ domain: ctx.brand.domain, ingestPath: ctx.brand.ingest_path, product: p });
      return {
        toolUseId: use.id,
        tool: use.name,
        args,
        content: JSON.stringify({
          ref: args.ref,
          title: p.title,
          price_cents: r.value.priceCents,
          currency: ctx.brand.currency ?? 'USD',
          available: r.value.available,
          source: r.source,
        }),
        source: r.source,
        ok: r.ok,
        ms: Date.now() - started,
      };
    }

    case 'check_availability': {
      const p = product();
      if (!p) return fail(`No product with reference "${args.ref}". Use a catalog number you were shown.`);
      const r = await checkAvailability({ domain: ctx.brand.domain, ingestPath: ctx.brand.ingest_path, product: p });
      return {
        toolUseId: use.id,
        tool: use.name,
        args,
        content: JSON.stringify({ ref: args.ref, title: p.title, available: r.value.available, source: r.source }),
        source: r.source,
        ok: r.ok,
        ms: Date.now() - started,
      };
    }

    case 'search_policy': {
      const r = searchPolicy({ brandId: ctx.brand.id, query: String(args.query ?? ''), limit: 3 });
      return {
        toolUseId: use.id,
        tool: use.name,
        args,
        content: r.value.length
          ? JSON.stringify(r.value.map((h) => ({ kind: h.kind, text: h.text.slice(0, 1200) })))
          : 'Nothing in the policy text matches that. Do not guess — escalate instead.',
        source: r.source,
        ok: r.ok,
        ms: Date.now() - started,
      };
    }

    default:
      return fail(`Unknown tool "${use.name}".`);
  }
}
