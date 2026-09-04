export type IngestPath = 'shopify' | 'crawl' | 'blocked';

export type PreflightResult = {
  domain: string;
  path: IngestPath;
  /** Human-readable verdict shown in the console before any wait begins. */
  detail: string;
  /** Named wall, when blocked: 'imperva' | 'cloudflare' | 'forbidden' | 'unreachable' */
  wall?: string;
  ms: number;
};

export type PackProduct = {
  sku: string | null;
  variantId: string | null;
  title: string;
  priceCents: number;
  currency: string;
  available: boolean;
  productType: string | null;
  tags: string[];
  description: string;
  url: string;
  imageUrl: string | null;
};

export type PackPolicy = {
  kind: 'shipping' | 'returns' | 'terms' | 'faq' | 'about';
  text: string;
  sourceUrl: string;
};

export type ContextPack = {
  brand: {
    name: string;
    domain: string;
    currency: string;
    logoUrl: string | null;
    palette: string[];
    category: 'alcohol' | 'supplement' | 'general';
    smsVendor: string | null;
    ingestPath: IngestPath;
    /** Storefront MCP tools this brand exposes, discovered at ingest. */
    mcpTools: string[];
  };
  products: PackProduct[];
  policies: PackPolicy[];
  /** Only what is on-site. Everything else is unauthorised. */
  offers: string[];
  restrictedRegions: string[];
  freeShipThreshold?: number;
  /** What ingest could not find. Surfaced in the console rather than silently guessed. */
  missing: string[];
};

export type ProgressEvent =
  | { type: 'stage'; stage: string; detail?: string }
  | { type: 'count'; label: string; value: number }
  | { type: 'warn'; message: string }
  | { type: 'done'; brandId: string }
  | { type: 'error'; message: string };

export type OnProgress = (e: ProgressEvent) => void;
