import { safeFetch } from './fetch.js';

const SMS_VENDORS: { name: string; pattern: RegExp }[] = [
  { name: 'attentive', pattern: /attn\.tv|attentivemobile|cdn\.attn\.tv|attentive\.com/i },
  { name: 'postscript', pattern: /postscript\.io|sdk\.postscript/i },
  { name: 'klaviyo', pattern: /klaviyo\.com|static\.klaviyo/i },
  { name: 'emotive', pattern: /emotive\.io|getemotive/i },
  { name: 'yotpo', pattern: /yotpo\.com|smsbump/i },
];

/**
 * Which SMS vendor the brand already runs, from script tags. Shown in the console
 * without editorialising — it is competitive intelligence, not a talking point.
 */
export function detectSmsVendor(html: string): string | null {
  for (const v of SMS_VENDORS) if (v.pattern.test(html)) return v.name;
  return null;
}

const ALCOHOL = /\b(wine|winery|vintner|cabernet|chardonnay|pinot|rosé|rose wine|whisk(e)?y|bourbon|tequila|vodka|gin\b|rum\b|brewery|beer|cider|spirits|sommelier|vineyard)\b/i;
const SUPPLEMENT = /\b(supplement|vitamin|nutraceutical|creatine|collagen|probiotic|amino acid|protein powder|nootropic|dietary supplement)\b/i;

/** Drives which policy module switches on: age gates, restricted regions, claim limits. */
export function classifyCategory(
  html: string,
  productTitles: string[],
): 'alcohol' | 'supplement' | 'general' {
  const corpus = `${html.slice(0, 60_000)} ${productTitles.slice(0, 120).join(' ')}`;
  const alcoholHits = (corpus.match(new RegExp(ALCOHOL, 'gi')) ?? []).length;
  const supplementHits = (corpus.match(new RegExp(SUPPLEMENT, 'gi')) ?? []).length;
  if (alcoholHits >= 3 && alcoholHits >= supplementHits) return 'alcohol';
  if (supplementHits >= 3) return 'supplement';
  return 'general';
}

function meta(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
    'i',
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
    'i',
  );
  return html.match(re)?.[1] ?? html.match(alt)?.[1] ?? null;
}

function isGrey(hex: string): boolean {
  const n = hex.length === 4
    ? hex.slice(1).split('').map((c) => parseInt(c + c, 16))
    : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
  const [r, g, b] = n;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min < 24 || max > 245 || max < 24;
}

/**
 * Dominant brand colours, so the thread renders in the brand's own palette rather than
 * a generic theme. Frequency over the homepage and its first stylesheets; greys and
 * near-black/white dropped since every site is full of them.
 */
export function extractPalette(sources: string[]): string[] {
  const counts = new Map<string, number>();
  for (const src of sources) {
    for (const m of src.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
      const hex = `#${m[1].toLowerCase()}`;
      if (isGrey(hex)) continue;
      const full = hex.length === 4
        ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
        : hex;
      counts.set(full, (counts.get(full) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h]) => h);
}

export type BrandMeta = {
  name: string | null;
  description: string | null;
  logoUrl: string | null;
  palette: string[];
  smsVendor: string | null;
  html: string;
};

export async function fetchBrandMeta(domain: string): Promise<BrandMeta> {
  const { body: html } = await safeFetch(`https://${domain}/`, { timeoutMs: 10_000 });

  const sheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((h) => !h.startsWith('data:'))
    .slice(0, 2);

  const css = await Promise.all(
    sheets.map(async (href) => {
      try {
        const url = new URL(href, `https://${domain}/`).toString();
        const { body } = await safeFetch(url, { timeoutMs: 8000 });
        return body.slice(0, 400_000);
      } catch {
        return '';
      }
    }),
  );

  const logo = meta(html, 'og:image');

  return {
    name: meta(html, 'og:site_name') ?? meta(html, 'og:title') ?? html.match(/<title[^>]*>([^<]+)</i)?.[1]?.trim() ?? null,
    description: meta(html, 'og:description') ?? meta(html, 'description'),
    // Brands still publish http:// og:image URLs, which a console served over https
    // silently refuses as mixed content. Upgrade rather than render a broken avatar.
    logoUrl: logo ? logo.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://') : null,
    palette: extractPalette([html, ...css]),
    smsVendor: detectSmsVendor(html),
    html,
  };
}
