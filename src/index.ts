import { parse, type HTMLElement } from 'node-html-parser';

interface Env {
  STATE: KVNamespace;
  WATCH: string;
  BARK_BASE: string;
  API_KEY: string;
  TZ?: string;
  NOTIFY?: string;
}

interface Watch {
  region: string;
  category: string;
}

interface Product {
  url: string;
  name: string;
  price: string;
  priceNum: number;
}

type Snapshot = Record<string, { url: string; name: string; price: string; priceNum: number }>;

type EventKind = 'new' | 'drop' | 'up' | 'removed';

type Event =
  | { kind: 'new'; product: Product }
  | { kind: 'drop'; product: Product; oldPrice: string }
  | { kind: 'up'; product: Product; oldPrice: string }
  | { kind: 'removed'; product: Product };

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const noStore = { 'cache-control': 'no-store' };

    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.pathname !== '/' && !isLocal) {
      const key = url.searchParams.get('key') || req.headers.get('x-api-key') || '';
      if (!env.API_KEY || key !== env.API_KEY) {
        return new Response('unauthorized\n', { status: 401, headers: noStore });
      }
    }

    if (url.pathname === '/run') {
      await runAll(env);
      return new Response('ok\n', { headers: noStore });
    }
    if (url.pathname === '/state') {
      const out: Record<string, Snapshot | null> = {};
      for (const w of parseWatches(env.WATCH)) {
        out[`${w.region}:${w.category}`] = await env.STATE.get<Snapshot>(stateKey(w), 'json');
      }
      return Response.json(out, { headers: noStore });
    }
    if (url.pathname === '/test-push') {
      if (!env.BARK_BASE)
        return new Response('BARK_BASE not set\n', { status: 500, headers: noStore });
      const tz = env.TZ || (req.cf?.timezone as string | undefined);
      const r = await fetch(env.BARK_BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'apple-refurb-watcher test',
          body: `End-to-end test at ${formatLocalTime(new Date(), tz)}`,
          group: 'apple-refurb-test',
        }),
      });
      return new Response(`bark HTTP ${r.status}\n${await r.text()}\n`, {
        status: r.ok ? 200 : 500,
        headers: { 'content-type': 'text/plain', ...noStore },
      });
    }
    if (url.pathname === '/raw') {
      const region = (url.searchParams.get('region') || 'au').toLowerCase();
      const category = (url.searchParams.get('category') || 'mac').toLowerCase();
      const target = pageUrl({ region, category });
      const r = await fetchApple(target);
      const html = decodeUtf8(await r.arrayBuffer());
      return new Response(html, {
        status: r.status,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...noStore },
      });
    }
    return new Response(
      [
        'apple-refurb-watcher',
        '',
        'GET /run                          trigger a check now',
        'GET /state                        inspect last saved snapshots',
        'GET /raw?region=au&category=mac   fetch Apple page as text/plain (view source)',
        'GET /test-push                    fire a test Bark notification',
        '',
        `watching: ${env.WATCH}`,
      ].join('\n'),
      { headers: { 'content-type': 'text/plain', ...noStore } },
    );
  },
};

async function runAll(env: Env): Promise<void> {
  const watches = parseWatches(env.WATCH);
  for (const w of watches) {
    try {
      await checkOne(w, env);
    } catch (e) {
      console.error(`[${w.region}:${w.category}] check failed:`, (e as Error).message);
    }
  }
}

function parseWatches(raw: string): Watch[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [region, category] = s.split(':').map((x) => x.trim().toLowerCase());
      if (!region || !category) throw new Error(`Invalid WATCH entry: "${s}" (expected "region:category")`);
      return { region, category };
    });
}

function stateKey(w: Watch): string {
  return `state:${w.region}:${w.category}`;
}

function baseUrl(region: string): string {
  if (region === 'cn') return 'https://www.apple.com.cn';
  return 'https://www.apple.com';
}

function pageUrl(w: Watch): string {
  const base = baseUrl(w.region);
  const prefix = w.region === 'us' || w.region === 'cn' ? '' : `/${w.region}`;
  return `${base}${prefix}/shop/refurbished/${w.category}`;
}

function absolutize(href: string, region: string): string {
  return href.startsWith('http') ? href : `${baseUrl(region)}${href}`;
}

function productCode(url: string): string {
  const m = url.match(/\/shop\/product\/([^/?]+(?:\/[^/?]+)?)/);
  return m ? m[1].toLowerCase() : url;
}

function fetchApple(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
}

function formatLocalTime(d: Date, tz?: string): string {
  if (!tz) return d.toISOString();
  return `${d.toLocaleString('sv-SE', { timeZone: tz })} ${tz}`;
}

function decodeUtf8(buf: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(buf);
}

async function checkOne(w: Watch, env: Env): Promise<void> {
  const url = pageUrl(w);
  const res = await fetchApple(url);
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const html = decodeUtf8(await res.arrayBuffer());

  const products = parseProducts(html, w.region);
  if (products.length === 0) {
    console.warn(`[${w.region}:${w.category}] parsed 0 products from ${url} (selectors may need updating)`);
    return;
  }

  const current: Snapshot = {};
  for (const p of products) current[productCode(p.url)] = { url: p.url, name: p.name, price: p.price, priceNum: p.priceNum };

  const key = stateKey(w);
  const previous = await env.STATE.get<Snapshot>(key, 'json');
  await env.STATE.put(key, JSON.stringify(current));

  if (!previous) {
    console.log(`[${w.region}:${w.category}] baseline saved (${products.length} products)`);
    return;
  }

  const kinds = parseNotifyKinds(env.NOTIFY);
  const events: Event[] = [];
  for (const p of products) {
    const code = productCode(p.url);
    const prev = previous[code];
    if (!prev) {
      events.push({ kind: 'new', product: p });
    } else if (p.priceNum > 0 && prev.priceNum > 0 && p.priceNum < prev.priceNum) {
      events.push({ kind: 'drop', product: p, oldPrice: prev.price });
    } else if (p.priceNum > 0 && prev.priceNum > 0 && p.priceNum > prev.priceNum) {
      events.push({ kind: 'up', product: p, oldPrice: prev.price });
    }
  }
  for (const [code, prev] of Object.entries(previous)) {
    if (!current[code]) {
      events.push({ kind: 'removed', product: { url: prev.url, name: prev.name, price: prev.price, priceNum: prev.priceNum } });
    }
  }

  let sent = 0;
  for (const ev of events) {
    if (kinds.has(ev.kind)) { await notify(env, w, ev); sent++; }
  }
  console.log(
    `[${w.region}:${w.category}] ${products.length} products, ${events.length} changes, ${sent} notified`,
  );
}

function parseProducts(html: string, region: string): Product[] {
  const root = parse(html);
  const tiles: HTMLElement[] = [
    ...root.querySelectorAll('div.rf-refurb-category-grid-no-js li'),
    ...root.querySelectorAll('ul.as-producttile-grid > li'),
    ...root.querySelectorAll('[data-analytics-section="grid"] li'),
  ];

  const seen = new Set<string>();
  const products: Product[] = [];

  for (const tile of tiles) {
    const anchor = tile.querySelector('a[href*="/shop/product/"]');
    if (!anchor) continue;
    const href = (anchor.getAttribute('href') || '').split('?')[0];
    if (!href) continue;
    const url = absolutize(href, region);
    if (seen.has(url)) continue;
    seen.add(url);

    const name = cleanText(
      anchor.text || tile.querySelector('h3')?.text || tile.querySelector('h2')?.text || '',
    );
    const priceEl =
      tile.querySelector('.as-price-currentprice') ||
      tile.querySelector('[class*="currentprice"]') ||
      tile.querySelector('[class*="price"]');
    const priceText = cleanText(priceEl?.text || '') || (tile.text.match(/[€£$¥][\d,.\s]+/)?.[0] ?? '');
    const priceNum = Number(priceText.replace(/[^\d.]/g, '')) || 0;

    if (name) products.push({ url, name, price: priceText.trim(), priceNum });
  }

  if (products.length === 0) {
    const re = /<a[^>]+href="(\/(?:[a-z]{2}\/)?shop\/product\/[A-Za-z0-9]+\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const url = absolutize(m[1].split('?')[0], region);
      if (seen.has(url)) continue;
      seen.add(url);
      const name = cleanText(m[2].replace(/<[^>]+>/g, ''));
      if (name) products.push({ url, name, price: '', priceNum: 0 });
    }
  }

  return products;
}

const DEFAULT_NOTIFY: EventKind[] = ['new', 'drop'];

function parseNotifyKinds(raw?: string): Set<EventKind> {
  if (!raw) return new Set(DEFAULT_NOTIFY);
  const valid = new Set<EventKind>(['new', 'drop', 'up', 'removed']);
  const kinds = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => valid.has(s as EventKind)) as EventKind[];
  return new Set(kinds.length ? kinds : DEFAULT_NOTIFY);
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

async function notify(env: Env, w: Watch, ev: Event): Promise<void> {
  if (!env.BARK_BASE) {
    console.warn('BARK_BASE not set, skipping:', ev.kind, ev.product.url);
    return;
  }
  const tag = `${w.region.toUpperCase()} ${w.category}`;
  const titles: Record<EventKind, string> = {
    new: `New refurb · ${tag}`,
    drop: `Price drop · ${tag}`,
    up: `Price up · ${tag}`,
    removed: `Sold out · ${tag}`,
  };
  const title = titles[ev.kind];
  const body =
    ev.kind === 'new'
      ? `${ev.product.name}${ev.product.price ? ' - ' + ev.product.price : ''}`
      : ev.kind === 'removed'
        ? ev.product.name
        : `${ev.product.name}: ${ev.oldPrice} → ${ev.product.price}`;

  const payload = {
    title,
    body,
    url: ev.product.url,
    group: `apple-refurb-${w.region}-${w.category}`,
  };
  const res = await fetch(env.BARK_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error('bark POST failed:', res.status, await res.text());
  }
}
