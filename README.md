# apple-refurb-watcher

A tiny Cloudflare Worker that polls Apple's refurbished store pages and sends a
[Bark](https://github.com/Finb/Bark) push notification to your phone when:

- a new product appears, or
- the price of an existing product drops.

Configurable per region and category — the Worker only fetches what you list.

## How it works

1. A cron trigger fires the Worker every 10 minutes.
2. For each `region:category` in `WATCH`, the Worker fetches
   `https://www.apple.com/<region>/shop/refurbished/<category>`
   (US has no region prefix).
3. Tiles are parsed out of the HTML; the snapshot (`url → name, price`) is
   compared against the previous snapshot in Workers KV.
4. New SKUs and price drops are POSTed to your Bark endpoint.

The first run for a new `region:category` is silent — it only writes the
baseline. Subsequent runs notify on diffs.

## Setup

```bash
npm install
npx wrangler login

# 1. Create the KV namespace, then paste the returned id into wrangler.toml
npx wrangler kv namespace create STATE

# 2. Set your Bark endpoint as a secret
#    Format: https://api.day.app/<your_device_key>  (or your self-hosted URL)
npx wrangler secret put BARK_BASE

# 3. Edit `WATCH` in wrangler.toml — comma-separated list of region:category
#    Examples:
#      WATCH = "au:mac"
#      WATCH = "au:mac,au:ipad,us:mac"
#      WATCH = "uk:mac,uk:ipad,uk:iphone"

# 4. Deploy
npm run deploy
```

## Manual endpoints

Once deployed, the Worker also responds to plain HTTP:

- `GET /`        — health page, shows the configured `WATCH`
- `GET /run`     — trigger a check immediately (useful for testing)
- `GET /state`   — JSON dump of the last saved snapshot per watch

## Regions & categories

- **Region**: `us` (no path prefix), or a country code Apple supports
  (`au`, `uk`, `ca`, `jp`, `de`, `fr`, `it`, `es`, `nl`, ...).
- **Category** is whatever slug Apple uses under `/shop/refurbished/`,
  typically: `mac`, `ipad`, `iphone`, `appletv`, `homepod`, `airpods`,
  `accessories`. Not every category exists in every region.

If a watch logs `parsed 0 products`, either the region/category combo doesn't
exist there, or Apple changed the HTML — adjust the selectors in
`parseProducts()` in `src/index.ts`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # then edit BARK_BASE
npm run dev
# in another terminal:
curl http://localhost:8787/run
```

## Notes

- Polling interval is in `wrangler.toml` (`crons = ["*/10 * * * *"]`).
- Bark notifications are grouped per `apple-refurb-<region>-<category>` so
  they collapse nicely on iOS.
- Removed products (sold out) are intentionally not notified — keep it simple.
