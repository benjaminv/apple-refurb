import { parse, type HTMLElement } from 'node-html-parser';

interface Env {
  STATE: KVNamespace;
  WATCH: string;
  BARK_BASE: string;
  TZ?: string;
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

type Snapshot = Record<string, { name: string; price: string; priceNum: number }>;

type Event =
  | { kind: 'new'; product: Product }
  | { kind: 'drop'; product: Product; oldPrice: string };

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run') {
      await runAll(env);
      return new Response('ok\n');
    }
    if (url.pathname === '/state') {
      const out: Record<string, Snapshot | null> = {};
      for (const w of parseWatches(env.WATCH)) {
        out[`${w.region}:${w.category}`] = await env.STATE.get<Snapshot>(stateKey(w), 'json');
      }
      return Response.json(out);
    }
    if (url.pathname === '/test-push') {
      if (!env.BARK_BASE) return new Response('BARK_BASE not set\n', { status: 500 });
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
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url.pathname === '/debug') {
      const region = (url.searchParams.get('region') || 'au').toLowerCase();
      const category = (url.searchParams.get('category') || 'mac').toLowerCase();
      return Response.json(await debugPage({ region, category }));
    }
    return new Response(
      [
        'apple-refurb-watcher',
        '',
        'GET /run                          trigger a check now',
        'GET /state                        inspect last saved snapshots',
        'GET /debug?region=au&category=mac inspect parser against live HTML',
        'GET /test-push                    fire a test Bark notification',
        '',
        `watching: ${env.WATCH}`,
      ].join('\n'),
      { headers: { 'content-type': 'text/plain' } },
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

function pageUrl(w: Watch): string {
  const prefix = w.region === 'us' ? '' : `/${w.region}`;
  return `https://www.apple.com${prefix}/shop/refurbished/${w.category}`;
}

function absolutize(href: string): string {
  return href.startsWith('http') ? href : `https://www.apple.com${href}`;
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

// Apple's refurb pages have no charset header, so the Workers runtime
// pre-decodes the body as Windows-1252 and we receive UTF-8 bytes of that
// mis-decoded string. Reverse: re-encode each char as Windows-1252, decode
// as UTF-8. Applied per-text-string (not whole-HTML) so unaffected chars
// elsewhere on the page don't make us bail.
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

function fixMojibake(s: string): string {
  if (!/Ã.|Â.|â€/.test(s)) return s;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
    } else if (code in CP1252_HIGH) {
      bytes.push(CP1252_HIGH[code]);
    } else {
      return s;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return s;
  }
}

async function checkOne(w: Watch, env: Env): Promise<void> {
  const url = pageUrl(w);
  const res = await fetchApple(url);
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const html = decodeUtf8(await res.arrayBuffer());

  const products = parseProducts(html);
  if (products.length === 0) {
    console.warn(`[${w.region}:${w.category}] parsed 0 products from ${url} (selectors may need updating)`);
    return;
  }

  const current: Snapshot = {};
  for (const p of products) current[p.url] = { name: p.name, price: p.price, priceNum: p.priceNum };

  const key = stateKey(w);
  const previous = await env.STATE.get<Snapshot>(key, 'json');
  await env.STATE.put(key, JSON.stringify(current));

  if (!previous) {
    console.log(`[${w.region}:${w.category}] baseline saved (${products.length} products)`);
    return;
  }

  const events: Event[] = [];
  for (const p of products) {
    const prev = previous[p.url];
    if (!prev) {
      events.push({ kind: 'new', product: p });
    } else if (p.priceNum > 0 && prev.priceNum > 0 && p.priceNum < prev.priceNum) {
      events.push({ kind: 'drop', product: p, oldPrice: prev.price });
    }
  }

  for (const ev of events) await notify(env, w, ev);
  console.log(
    `[${w.region}:${w.category}] ${products.length} products, ${events.length} notifications`,
  );
}

function parseProducts(html: string): Product[] {
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
    const url = absolutize(href);
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
      const url = absolutize(m[1].split('?')[0]);
      if (seen.has(url)) continue;
      seen.add(url);
      const name = cleanText(m[2].replace(/<[^>]+>/g, ''));
      if (name) products.push({ url, name, price: '', priceNum: 0 });
    }
  }

  return products;
}

function cleanText(s: string): string {
  return fixMojibake(s.replace(/\s+/g, ' ').trim());
}

async function debugPage(w: Watch): Promise<unknown> {
  const url = pageUrl(w);
  const res = await fetchApple(url);
  if (!res.ok) return { url, httpStatus: res.status, ok: false };
  const html = decodeUtf8(await res.arrayBuffer());

  const hrefRe = /href="(\/(?:[a-z]{2}\/)?shop\/product\/[A-Za-z0-9]+\/[^"]+)"/gi;
  const hrefs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html))) hrefs.add(m[1].split('?')[0]);

  const root = parse(html);
  const anchors = root.querySelectorAll('a[href*="/shop/product/"]');

  const ancestorClassCounts: Record<string, number> = {};
  for (const a of anchors.slice(0, 30)) {
    let cur = a.parentNode as HTMLElement | null;
    for (let depth = 0; depth < 5 && cur; depth++) {
      const tag = (cur.rawTagName || '').toLowerCase();
      const cls = (cur.getAttribute?.('class') || '').trim();
      if (tag && cls) {
        const key = `${tag}.${cls.split(/\s+/).filter(Boolean).join('.')}`;
        ancestorClassCounts[key] = (ancestorClassCounts[key] || 0) + 1;
      }
      cur = cur.parentNode as HTMLElement | null;
    }
  }
  const topAncestorClasses = Object.entries(ancestorClassCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  let tileSnippet = '';
  const firstAnchor = anchors[0];
  if (firstAnchor) {
    let cur: HTMLElement | null = firstAnchor as unknown as HTMLElement;
    for (let i = 0; i < 4 && cur?.parentNode; i++) cur = cur.parentNode as HTMLElement;
    tileSnippet = (cur?.outerHTML || '').slice(0, 1500);
  }

  const products = parseProducts(html);
  const mojibakeProbe = '10â€‘Core CPU — MacBookÂ Pro â€”';
  return {
    url,
    httpStatus: res.status,
    htmlLength: html.length,
    productHrefsByRegex: hrefs.size,
    productHrefsSample: [...hrefs].slice(0, 5),
    productAnchorsByDom: anchors.length,
    parsedByCurrentSelectors: products.length,
    parsedNamesSample: products.slice(0, 3).map((p) => ({
      name: p.name,
      codes: [...p.name].map((c) => c.charCodeAt(0).toString(16)).join(' '),
    })),
    mojibakeSelfTest: {
      input: mojibakeProbe,
      cleanTextOutput: cleanText(mojibakeProbe),
      fixMojibakeOutput: fixMojibake(mojibakeProbe),
    },
    topAncestorClasses,
    tileSnippet,
  };
}

async function notify(env: Env, w: Watch, ev: Event): Promise<void> {
  if (!env.BARK_BASE) {
    console.warn('BARK_BASE not set, skipping:', ev.kind, ev.product.url);
    return;
  }
  const tag = `${w.region.toUpperCase()} ${w.category}`;
  const title = ev.kind === 'new' ? `New refurb · ${tag}` : `Price drop · ${tag}`;
  const body =
    ev.kind === 'new'
      ? `${ev.product.name}${ev.product.price ? ' — ' + ev.product.price : ''}`
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
