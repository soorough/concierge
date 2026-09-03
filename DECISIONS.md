# Decisions

Why this is built the way it is. Each entry names the tradeoff, not just the choice.

## 1. No vector DB

One brand's catalog is ~100 products and a few dozen policy chunks. Embeddings would add
a build step, an API call on the turn path, and an index that drifts from the catalog.
SQLite FTS5 is in-process, sub-millisecond at this size, and *better* than embeddings at
what shoppers actually type — proper nouns. "Vintner Cabernet Sauvignon 2023" is a lexical
match; embeddings blur exactly the tokens that distinguish one bottle from another.

Semantic queries ("something bold for a steak dinner") are covered because tasting notes
live in the indexed product copy. This breaks down past a few thousand SKUs, or when
queries stop naming things. That's the point to go hybrid — not to switch to pure vectors.

## 2. Sellability is a price rule, not a type allowlist

Verified against ONEHOPE's live catalog (122 products): `product_type` alone does not
separate sellable from junk. The empty-type bucket holds real $100-$200 wines alongside
$0 packaging ("2 Bottle Wood Box Shipper", "Crinkle"); `Bundle` holds real $43 trios
alongside $0 wine-club placeholders.

    sellable = min_variant_price > 0 AND available AND product_type NOT IN denylist

Measured: 122 total, 98 sellable, 24 excluded. The denylist is per-brand config, not a
global constant, and `NON_SELLABLE_SKU` backstops it as a post-model rail. An agent that
offers a customer "Packaging & Fulfillment" has destroyed the premise that it knows the
business — so this fails closed in two places.

## 3. FTS5 external-content tables need name-matched columns

`content='product'` maps FTS columns to base-table columns *by name*. Declaring
`fts5(title, description, tags)` over a table whose column is `tags_json` inserts fine and
fails on read — a silently empty index that looks like a bad retriever. `store/check-fts.ts`
loads a real catalog and asserts row parity plus delete-trigger behaviour.

## 4. Append-only facts, with provenance precedence

Two separate arguments.

*Append-only* is the audit argument: when a brand asks why the agent said that to a
customer in March, a ledger answers and a mutable profile blob does not.

*Provenance precedence* is the correctness argument: first-party (what the customer said
in the thread) supersedes third-party (what a rep wrote in a field note), regardless of
which arrived first; newest wins between two facts of the same provenance.

Cost: every read filters `valid_to IS NULL` and the table grows forever. At real volume
you'd materialise a current-facts view. That's a scaling answer, not an argument against
the model.

## 5. Price tokens

The model emits `{{price:SKU}}`; the database substitutes. A hallucinated price isn't
discouraged by the prompt, it's unavailable — the model never holds a number to get wrong.

The honest limit: this closes the numeric channel, not the price channel. A model can
still write "around thirty dollars". That gap is closed by a prompt rule against
approximating price at all, plus the `UNGROUNDED_PRICE` rail. The calibrated claim is
stronger than the absolute one.

## 6. Simulator, with a Channel interface

No Meta or Apple credentials, and new WhatsApp Business accounts can land in a review
queue that cannot be accelerated. More to the point, the product is not the webhook.

The `Channel` interface is what makes this a cut rather than a gap: WhatsApp adds Meta's
paperwork (dedupe on redelivery, async ack within 1s, the 24-hour window, template
approval); iMessage adds Apple approval and a registered provider. Naming precisely what
was skipped is the difference.

## 7. No payments — the cart is real instead

The checkout card is real: the stepper and remove mutate server-side cart state, and the
subtotal recomputes from database prices, never from anything the model said. The CTA is a
Shopify cart permalink (`/cart/{variant_id}:{qty}`) that lands on the brand's own cart,
pre-filled.

This is more defensible than test-mode payments: no money moves through infrastructure
that has no agreement with the brand, and the destination is genuinely real rather than
simulated. In-thread payment is Apple's surface.

## 8. SQLite on a mounted volume, single instance

One file, in-process, sub-millisecond FTS5, and the reason this is buildable in days. A
persistent Railway volume means no Turso and no network hop per query, so retrieval stays
under 30ms.

Accepted: single instance, no horizontal scaling, and backups are "copy the file".

## 9. Model-agnostic by design

`callModel()` behind one interface; Haiku 4.5 by default, DeepSeek switchable at runtime.
Three reasons: cost becomes a visible variable rather than a claim; a slow provider is an
env var away from being swapped; and the safety story holds on the cheapest model rather
than depending on the smartest one available.

Accepted: the interface is a swap point, not a guarantee of identical behaviour — native
structured output, prompt caching, and JSON adherence all differ, and per-provider prompt
variants are what comes next.

## 10. Blocked domains are refused, not retried

Roughly a third of commerce sites sit behind Imperva or Cloudflare (Summit Racing, FCP
Euro, CarID, McMaster all verified unreachable). Preflight classifies shopify / crawl /
blocked in about a second and hard-stops on blocked, naming the wall.

A product that says "I can't read this site and here's why" is more credible than one that
always appears to succeed.

## What I'd change with a month

Hybrid retrieval past a few thousand SKUs. A classifier pass for sellability instead of a
per-brand denylist. A real channel adapter with the brand's own credentials entered per
workspace. Magic-link auth over the shared password. A human approval mode before the
agent speaks to a real consumer — which is the question that matters most, and the one this
build deliberately stops short of.
