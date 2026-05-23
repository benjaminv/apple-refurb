# Handover — apple-refurb-watcher

State of this project as of 2026-05-24, written so you can pick it up
on desktop and finish the last loose end.

## What it does

Cloudflare Worker that polls Apple refurbished category pages on a
10-minute cron, diffs each snapshot against the previous one in KV,
and pushes a Bark notification on **new SKU** or **price drop**.

Configured via `WATCH` env var (e.g. `"au:mac,us:ipad"`) — the Worker
only fetches what's listed.

## What's deployed and confirmed working

- Cron + selectors (`div.rf-refurb-category-grid-no-js li`) — parses
  ~32 Mac tiles on `au:mac`.
- KV persistence + first-run baseline behaviour (silent first run).
- Bark push end-to-end — `/test-push` lands on the phone within
  seconds.
- Local timezone formatting via `request.cf.timezone` (no hardcoded
  zone).
- `/raw` shows Apple's HTML cleanly decoded (NBSP, U+2011 hyphen,
  em/en dashes all correct).

## What is NOT confirmed working

**The real notification path.** We've never observed an end-to-end
"Apple inventory changed → Bark push fires" in the wild. The
mechanism works (`/test-push` proves the wire and `/state` confirms
the diff source is correct), but no inventory diff has triggered
during this session. Watch logs over a day or two to confirm.

## Resolved during the session

**Mojibake.** Was real for a while, then fixed itself when
Apple/Cloudflare started returning clean UTF-8 (charset detection
behaviour seems to have changed mid-session). The eventual
"persistent mojibake in /state" turned out to be **iOS Safari
caching the old `/state` response**; bypassed with `?x=N` cache
buster. The `fixMojibake()` Windows-1252 reverse map in
`src/index.ts` remains as defensive code in case the original
decoding regresses.

### Local debug recipe (if anything regresses)

```bash
git clone git@github.com:benjaminv/apple-refurb.git
cd apple-refurb
npm install
npx wrangler login
# .dev.vars holds local BARK_BASE — see .dev.vars.example
npm run dev      # spins up local worker
npm run tail     # streams production logs
```

A 30-second Playwright/curl script that just fetches the AU mac page
and prints the first 500 bytes hex will instantly show whether Apple
serves a charset header now, and whether the response really is
double-encoded UTF-8 or genuinely clean. We never got to do this from
mobile — it would've saved hours.

```js
// quick local debug — Node 20+
const res = await fetch('https://www.apple.com/au/shop/refurbished/mac', {
  headers: { 'user-agent': 'Mozilla/5.0 ... Safari/605.1.15' },
});
console.log('content-type:', res.headers.get('content-type'));
const buf = Buffer.from(await res.arrayBuffer());
console.log('first bytes around MacBook:');
const idx = buf.indexOf('MacBook');
console.log(buf.slice(idx, idx + 60).toString('hex'));
console.log(buf.slice(idx, idx + 60).toString('utf-8'));
```

If `content-type` declares `charset=utf-8` and the hex bytes are
`C2 A0` for NBSP, then production should also work — re-deploy and
hit `/run`. If you see anything else, that's where the bug lives.

## Architecture

```
src/index.ts          # everything (~280 lines)
  scheduled()           # cron entrypoint
  fetch()               # HTTP endpoints
    GET /               # health page
    GET /run            # trigger a check now
    GET /state          # last-saved KV snapshots
    GET /raw            # Apple HTML as text/plain (mobile view-source)
    GET /test-push      # fire a test Bark notification
  checkOne()            # fetch + parse + diff + notify for one watch
  parseProducts()       # node-html-parser on tile selector
  fixMojibake()         # defensive Windows-1252 → UTF-8 repair
  notify()              # POST to BARK_BASE
.github/workflows/      # deploy to CF on push to main
wrangler.toml           # cron, KV binding, WATCH var, optional TZ
```

## Required configuration

| Where | Name | What |
| --- | --- | --- |
| `wrangler.toml` | `WATCH` | comma-separated `region:category` |
| KV namespace | `STATE` | id `504f111abc3e493f97231c5469e6c97d` |
| GH env `production` | `CLOUDFLARE_API_TOKEN` | Workers edit token |
| GH env `production` | `CLOUDFLARE_ACCOUNT_ID` | from CF dashboard URL |
| GH env `production` | `BARK_BASE` | `https://api.day.app/<device_key>` |
| Optional in `wrangler.toml` | `TZ` | IANA name to force a zone |

## URLs

- Worker: `https://apple-refurb-watcher.bvc.workers.dev`
- Repo: `https://github.com/benjaminv/apple-refurb`
- PR #2 (latest changes): `https://github.com/benjaminv/apple-refurb/pull/2`

## Deploying

Merge a PR to `main`, or run the `Deploy` workflow manually from the
Actions tab against any branch. Workflow lives in
`.github/workflows/deploy.yml` and is bound to the `production`
environment so it can read the secrets above.

## Lesson learned

When the dev sandbox can't reach the target site, switch to a
machine that can rather than iterating blindly through deploy →
mobile-debug → paste-back loops. A single local `curl` or
Playwright fetch would've shown Apple's actual response in 30
seconds and saved ~10 round trips on a phone keyboard.
