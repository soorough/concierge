/**
 * Sellability filter.
 *
 * Deliberately NOT a product_type allowlist. Verified against ONEHOPE's live catalog:
 * the empty-type bucket holds real $100-$200 wines next to $0 packaging, and `Bundle`
 * holds real $43 trios next to $0 wine-club placeholders. Type alone does not separate
 * sellable from junk. Price does.
 */
export const DEFAULT_TYPE_DENYLIST = [
  'Component',
  'wine-club-fee',
  'SUBLIMATION',
  'Rewards',
  'GiftCard',
];

export type SellabilityInput = {
  priceCents: number;
  available: boolean;
  productType: string | null;
};

export type SellabilityVerdict = { sellable: boolean; reason: string | null };

export function assessSellability(
  p: SellabilityInput,
  denylist: string[] = DEFAULT_TYPE_DENYLIST,
): SellabilityVerdict {
  const reasons: string[] = [];
  const type = p.productType ?? '';
  if (type && denylist.includes(type)) reasons.push(`type=${type}`);
  if (!(p.priceCents > 0)) reasons.push('price=0');
  if (!p.available) reasons.push('unavailable');
  return reasons.length
    ? { sellable: false, reason: reasons.join(',') }
    : { sellable: true, reason: null };
}
