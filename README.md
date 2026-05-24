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

## Setup (deploy via GitHub Actions — no local wrangler needed)

1. **Create a KV namespace** in the Cloudflare dashboard:
   Workers & Pages → KV → Create namespace, name it `STATE`.
   Copy the id and paste it into `wrangler.toml` (replacing
   `REPLACE_WITH_KV_NAMESPACE_ID`). Commit and push.

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

   Then push the secret to the Worker:
   ```bash
   echo "your-key-here" | npx wrangler secret put API_KEY
   ```

4. **Edit `WATCH`** in `wrangler.toml` — comma-separated `region:category`:

   ```
   WATCH = "au:mac"
   WATCH = "au:mac,au:ipad,us:mac"
   WATCH = "uk:mac,uk:ipad,uk:iphone"
   ```

5. **Deploy.** Push to `main`, or trigger the `Deploy` workflow manually from
   the Actions tab (works from any branch). The workflow typechecks, pushes
   `BARK_BASE` as a Worker secret, then `wrangler deploy`s.

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
- `GET /raw`         — fetch Apple's page as text/plain (view source)
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

## Notes

- Polling interval is in `wrangler.toml` (`crons = ["*/10 * * * *"]`).
- Bark notifications are grouped per `apple-refurb-<region>-<category>` so
  they collapse nicely on iOS.
- Removed products (sold out) are intentionally not notified — keep it simple.
