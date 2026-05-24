# apple-refurb-watcher

A tiny Cloudflare Worker that polls Apple's refurbished store pages and sends a
[Bark](https://github.com/Finb/Bark) push notification to your phone when
inventory changes — new listings, price drops, price increases, or sold-out
removals (configurable).

Configurable per region and category — the Worker only fetches what you list.

## How it works

1. A cron trigger fires the Worker every 10 minutes.
2. For each `region:category` in `WATCH`, the Worker fetches
   `https://www.apple.com/<region>/shop/refurbished/<category>`
   (US has no region prefix).
3. Tiles are parsed out of the HTML; the snapshot (`url → name, price`) is
   compared against the previous snapshot in Workers KV.
4. Changes (new SKUs, price drops, etc.) are POSTed to your Bark endpoint.

The first run for a new `region:category` is silent — it only writes the
baseline. Subsequent runs notify on diffs.

## Setup (deploy via GitHub Actions — no local wrangler needed)

1. **Create a KV namespace** in the Cloudflare dashboard:
   Workers & Pages → KV → Create namespace, name it whatever you like (e.g.
   `apple-refurb-STATE`). Copy the namespace ID and replace the `id` value
   under `[[kv_namespaces]]` in `wrangler.toml`. Commit and push.

2. **Get your Bark URL** from the Bark iOS app
   (https://github.com/Finb/Bark). Open the app and copy the URL at the top —
   it looks like `https://api.day.app/AbC123dEf/`. Or use your self-hosted
   Bark server URL.

3. **Add four GitHub Actions secrets** at
   `Settings → Environments → production` (the workflow is bound to this
   environment):

   | Secret | Where to get it |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | https://dash.cloudflare.com/profile/api-tokens → "Edit Cloudflare Workers" template |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard, right sidebar |
   | `BARK_BASE` | The Bark URL from step 2 |
   | `API_KEY` | A random secret string (e.g. `openssl rand -hex 16`). Required to access HTTP endpoints. |

4. **Edit `WATCH`** in `wrangler.toml` — comma-separated `region:category`:

   ```
   WATCH = "au:mac"
   WATCH = "au:mac,au:ipad,us:mac"
   WATCH = "uk:mac,uk:ipad,uk:iphone"
   ```

5. **Deploy.** Push to `main`, or trigger the `Deploy` workflow manually from
   the Actions tab (works from any branch). The workflow typechecks, pushes
   `BARK_BASE` and `API_KEY` as Worker secrets, then `wrangler deploy`s.

### Local development (optional)

```bash
npm install
cp .dev.vars.example .dev.vars   # then edit BARK_BASE and API_KEY
npm run dev
# in another terminal:
curl "http://localhost:8787/run?key=YOUR_API_KEY"
```

## Manual endpoints

All endpoints except `/` require authentication via `?key=YOUR_API_KEY` query
parameter or `x-api-key` header. Unauthenticated requests return `401`.

- `GET /`            — health page, shows the configured `WATCH` (public)
- `GET /run`         — trigger a check immediately (useful for testing)
- `GET /state`       — JSON dump of the last saved snapshot per watch
- `GET /raw?region=au&category=mac` — fetch Apple's page as text/plain (view source)
- `GET /test-push`   — fire a test Bark notification to your phone

## Regions & categories

- **Region**: `us` (no path prefix), or a country code Apple supports
  (`au`, `uk`, `ca`, `jp`, `de`, `fr`, `it`, `es`, `nl`, ...).
- **Category** is whatever slug Apple uses under `/shop/refurbished/`,
  typically: `mac`, `ipad`, `iphone`, `appletv`, `homepod`, `airpods`,
  `accessories`. Not every category exists in every region.

If a watch logs `parsed 0 products`, either the region/category combo doesn't
exist there, or Apple changed the HTML — adjust the selectors in
`parseProducts()` in `src/index.ts`.

## Notification types

Control which events trigger a push via the `NOTIFY` var in `wrangler.toml`:

| Kind | Description | Default |
| --- | --- | --- |
| `new` | A new product appears | yes |
| `drop` | Price decreased | yes |
| `up` | Price increased | no |
| `removed` | Product disappeared (sold out) | no |

```toml
# Default — only new listings and price drops:
# NOTIFY = "new,drop"

# Everything:
NOTIFY = "new,drop,up,removed"
```

If `NOTIFY` is unset, defaults to `new,drop`.

## Notes

- Polling interval is in `wrangler.toml` (`crons = ["*/10 * * * *"]`).
- Bark notifications are grouped per `apple-refurb-<region>-<category>` so
  they collapse nicely on iOS.
