# WPP Media Campaign Agent

AdOps tool for trafficking Meta campaigns at scale — weekly brief → approval → live push via Meta Marketing API. Built for the WPP Media AdOps team.

---

## What it does

1. **Brief** — AdOps fills a weekly form: markets, funnel stages, audience segments, creative assets, copy
2. **Preview & Approve** — Reviews every generated ad set before anything goes live
3. **Push** — Streams a real-time log as it creates campaigns, ad sets, and ads via Meta Marketing API
4. All ads are created **PAUSED** — budgets are set directly in Meta Ads Manager

---

## Prerequisites

Before deploying, you need:

1. **Vercel account** — [vercel.com](https://vercel.com) (free tier works)
2. **Meta System User token** with `ads_management` and `ads_read` scopes
3. **Meta Ad Account ID** (format: `act_XXXXXXXXXX`)
4. **Meta Pixel ID**

### Creating a System User token (do this first)

> System User tokens never expire — essential for a production tool.

1. Go to **business.facebook.com → Settings → Users → System Users**
2. Click **Add** → name it `campaign-agent` → role: **Employee**
3. Click **Generate New Token** → select your app → enable scopes:
   - `ads_management`
   - `ads_read`
4. Click **Add Assets** → assign your Ad Account to this System User (role: **Advertiser**)
5. Copy the token — you won't see it again

---

## Deploy to Vercel

### 1. Install Vercel CLI

```bash
npm install -g vercel
```

### 2. Clone / copy this project

```bash
cd campaign-agent
```

### 3. Create Vercel KV store (for push history)

```bash
vercel kv create campaign-agent-history
vercel env pull .env.local   # pulls KV credentials into local env
```

### 4. Add environment variables

In **Vercel Dashboard → Your Project → Settings → Environment Variables**, add:

| Variable | Value | Notes |
|---|---|---|
| `META_ACCESS_TOKEN` | Your System User token | Never commit this |
| `META_AD_ACCOUNT_ID` | `act_XXXXXXXXXX` | Include the `act_` prefix |
| `META_API_VERSION` | `v20.0` | Update when Meta releases new versions |
| `META_PIXEL_ID` | Your pixel ID | Numeric string |

Or add them via CLI:

```bash
vercel env add META_ACCESS_TOKEN
vercel env add META_AD_ACCOUNT_ID
vercel env add META_API_VERSION
vercel env add META_PIXEL_ID
```

### 5. Deploy

```bash
vercel deploy --prod
```

Your tool is live at `https://your-project.vercel.app`

---

## Local development

```bash
# Copy env template
cp .env.example .env.local
# Fill in your real values in .env.local

# Start local dev server (Vercel CLI emulates serverless functions)
npm run dev
# → http://localhost:3000
```

---

## API reference

### `POST /api/validate`
Validates a brief payload without making any Meta API calls. Call before push to surface errors early.

**Body:** Brief payload JSON  
**Response:** `{ valid: boolean, warnings: string[], errors: string[] }`

### `POST /api/push`
Executes the full campaign push. Returns a streaming NDJSON response — each line is a progress event.

**Body:** Brief payload JSON (same as validate)  
**Stream events:** `start` → `campaign` → `asset` → `adset` → `ad` → `done`

### `GET /api/status?campaignId=120xxxxx`
Returns live campaign status from Meta.

### `GET /api/history?limit=20`
Returns push history from Vercel KV (last 20 pushes, newest first).

---

## Meta API permissions required

Your System User needs these permissions on the Ad Account:

- **Ads Management** — create/edit campaigns, ad sets, ads
- **Ads Read** — read campaign status
- **Business Asset access** — access the Ad Account

---

## Architecture

```
public/index.html        WPP Media AdOps frontend (all screens)
api/
  push.js                Main push — streams NDJSON progress
  validate.js            Pre-push validation (no Meta calls)
  status.js              Campaign status check
  history.js             Push history from KV
lib/
  meta.js                All Meta Graph API calls (token lives here only)
  validate.js            Pure validation functions
  stream.js              NDJSON streaming helpers
  kv.js                  Vercel KV for push history
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Access token is invalid` (code 190) | Token expired or wrong | Generate a new System User token |
| `Invalid parameter` (code 100) | Wrong Ad Account ID format | Ensure it starts with `act_` |
| `Permission error` (code 200) | System User not assigned to Ad Account | Add the System User as Advertiser on your Ad Account |
| Push timeout | >120s for large batches | Split into smaller pushes (max ~40 ads) |
| History not loading | KV not configured | Run `vercel kv create` and `vercel env pull` |

---

## Questions?

Contact the WPP Media AdOps team or raise an issue in this repository.
