# CCTV + Weather Wall — I-26 / US-25 (Arden, NC)

A single always-on webpage for a TV monitor: live NC DOT traffic cameras for
the I-26 / US-25 corridor near Arden, NC, plus live weather (current
conditions, 3-day forecast, animated radar) for Arden, NC. Static
HTML/CSS/JS + one small Worker, deployed free on Cloudflare (Workers with
static assets).

## Status / open TODOs

This project was scaffolded before a DriveNC developer API key existed, so
one piece is unverified and should be the first thing checked once a key is
in hand:

- [ ] **Confirm the DriveNC Cameras API response shape for these specific
      NCDOT cameras.** `src/worker.js` guesses at field names (`VideoUrl`,
      `ImageUrl`, `SnapshotUrl`) based on DriveNC's public docs, which only
      confirm a `Views[].Url` (viewer page link) and an often-empty
      `Views[].VideoUrl` for *municipal* cameras. Once `DRIVENC_API_KEY` is
      set, call `https://www.drivenc.gov/api/v2/get/cameras?key=...&format=json`
      directly (e.g. with `curl`) and inspect a real NCDOT camera's JSON to see
      what media field is actually populated (snapshot JPG vs. a stream URL),
      then adjust `extractMedia()` in `src/worker.js` accordingly.
    - Note: the sample DriveNC data seen during research used a numeric `Id`
      (e.g. `4061`), not the GUIDs from the original drivenc.gov URLs
      (`07a325cd-...`). The proxy currently matches on both `c.Id` and
      `c.Guid` as a hedge — confirm which field the real response actually
      uses and simplify the matching logic once known.
- [ ] **Fix the duplicate camera GUID.** "US-25 — Old Airport Rd" was supplied
      with the exact same GUID as "I-26 MM41"
      (`1682cc9c-c58c-4485-a04b-b603ad8069f0`). Both tiles currently show the
      I-26 MM41 camera. Get the correct GUID for Old Airport Rd and update it
      in both `public/cameras.js` and `src/worker.js`.
- [ ] Verify each camera's `drivenc.gov/{guid}` viewer page is actually
      iframe-embeddable (no blocking `X-Frame-Options`/CSP) — this is the
      fallback path used whenever the API doesn't return usable media, and is
      also what renders before `/api/cameras` responds on first load.

Until the API key is configured, every tile falls back to an `<iframe>` of
its public `drivenc.gov` viewer page, so the wall is functional out of the
box — it just upgrades to direct media once the key + verified field mapping
are in place.

## Architecture

```
Browser (TV) ──> public/index.html / style.css / cameras.js / weather.js
                     │                              │
                     │ GET /api/cameras              │ direct fetch (no key needed)
                     ▼                              ▼
              src/worker.js                  api.weather.gov (NWS)
        (Cloudflare Worker, handles           api.rainviewer.com (radar)
         /api/cameras itself, otherwise
         falls through to static assets)
                     │
                     │ GET .../get/cameras?key=... (server-side only)
                     ▼
              DriveNC Cameras API
```

- **Deployment model:** this repo deploys as a single Cloudflare **Worker
  with static assets** (`wrangler.jsonc`: `main: src/worker.js`,
  `assets.directory: ./public`), not the older Pages-Functions
  (`/functions` directory) convention. Cloudflare's Git-integration build
  pipeline for this project runs `npx wrangler deploy`, which needs exactly
  this shape — a single entry-point script plus an assets directory — so
  don't reintroduce a `/functions` folder expecting file-based routing; add
  new server routes as branches inside `src/worker.js`'s `fetch()` instead.
- **Cameras** come from DriveNC's official Cameras REST API, called from
  `src/worker.js` so the API key never reaches the browser and so repeated
  page refreshes across however many TVs are running this don't exceed
  DriveNC's **10 requests / 60 seconds** rate limit — the Worker caches the
  upstream response for 90 seconds.
- **Weather** (current conditions + forecast) comes straight from the client
  to `api.weather.gov` (NWS) — free, no API key. Flow: `/points/{lat},{lon}`
  → forecast URL + nearest observation station → `/observations/latest`.
- **Radar** uses RainViewer's free public Weather Maps API
  (`api.rainviewer.com/public/weather-maps.json`) for tile URLs, rendered
  with Leaflet on a CARTO dark basemap, animated over the last ~6 frames.
  RainViewer's free tier is for personal/small-scale use and requires the
  attribution link that's already in `index.html` — don't remove it.
- No framework/build step for the front end. It's `public/index.html` +
  `public/style.css` + two ES modules (`public/cameras.js`,
  `public/weather.js`) plus one Worker script for the DriveNC proxy. Kept
  intentionally simple since this just needs to run unattended on a TV.

## Cameras

Priority camera (rendered larger, top of the grid):

| Label | GUID |
|---|---|
| **I-26 MM37 — Long Shoals Rd** | `07a325cd-ac00-4a93-8a15-478338f71dbd` |

Remaining cameras:

| Label | GUID |
|---|---|
| I-26 MM36 | `30a32301-7288-42ab-aec5-0686e9198ef6` |
| I-26 MM39 | `ae534a09-3f42-40b1-b15e-33a07ae8c8ae` |
| I-26 MM40 | `3d273c12-0bec-40d4-868c-1b8ee5ad434d` |
| I-26 MM41 | `1682cc9c-c58c-4485-a04b-b603ad8069f0` |
| I-26 MM44 — US-25 | `35916952-ece1-4fc9-8f86-fbccebf8e3c5` |
| I-26 MM45 | `00bec6b8-bfe4-4f92-81ec-caa12f09fe11` |
| US-25 — Old Airport Rd ⚠️ *duplicate GUID, needs correction* | `1682cc9c-c58c-4485-a04b-b603ad8069f0` |
| US-25 — Airport Rd | `081e9880-28ba-4059-a657-bf0094b8b29a` |
| US-25 — Long Shoals Rd | `45513374-a881-45f8-871d-1d09b4aa5a54` |
| US-25 — Gerber Village | `dc042f71-f086-47cf-aaac-fe5d44accfe2` |
| US-25 — Rock Hill Rd | `9e8d51bb-7d76-4230-abbe-5c87f52dce9e` |
| Airport Rd — Fanning Bridge Rd | `cfb396d1-5a86-4cd6-a73c-eb934f75535e` |
| Airport Rd — Ferncliff | `32d394f5-36ac-482d-88f7-606327300313` |

To add/remove/reorder cameras: edit `CAMERAS` in `public/cameras.js` and
`WANTED_CAMERA_IDS` in `src/worker.js` (both need the GUID; keep them in
sync). Set `priority: true` on at most one camera in `public/cameras.js` for
the large tile.

## Setup

### 1. DriveNC developer API key

1. Register a free account and request a Cameras API key at
   <https://www.drivenc.gov/developers/doc>.
2. Don't put the key in any file in this repo. It's supplied as an
   environment variable (see below).

### 2. Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in DRIVENC_API_KEY
npm run dev                      # wrangler dev, serves the Worker + static assets locally
```

(`.dev.vars` is git-ignored — see `.dev.vars.example` for the expected
variable name.)

### 3. Deploy — Cloudflare

This repo is already connected to Cloudflare's Git integration
(`lboone-bc/cctv-weather` → a Workers project) and deploys on every push to
`main` by running `npx wrangler deploy`, which `wrangler.jsonc` now points at
`src/worker.js` + `./public` assets, so no dashboard build-settings changes
should be needed. One thing to set:

- In the Cloudflare dashboard, open the Worker's **Settings → Variables and
  Secrets** and add `DRIVENC_API_KEY` as an encrypted secret (Production —
  and Preview if you use preview deployments).

To connect a fresh clone to a *new* Cloudflare project instead of the
existing one: **Workers & Pages → Create → Import a repository**, point it
at this repo — it will detect `wrangler.jsonc` and configure itself
correctly with no extra build/deploy command overrides needed.

### 4. Displaying on a TV

Point the TV's browser (smart TV browser, Fire TV Stick/Silk browser,
Chromecast with a kiosk tab, Raspberry Pi in kiosk mode, etc.) at the
deployed `*.workers.dev` URL (or a custom domain mapped to it). The page is
designed to fill the viewport with no scrolling (`overflow: hidden`) and
refreshes its own data on intervals, so it's meant to just be left open.

## Data sources & limits

| Source | Used for | Key required | Notes |
|---|---|---|---|
| [DriveNC Cameras API](https://www.drivenc.gov/developers/doc) | Camera media URLs | Yes (free) | 10 req/60s — proxied + cached server-side in `src/worker.js` |
| [api.weather.gov](https://www.weather.gov/documentation/services-web-api) (NWS) | Current conditions, 3-day forecast | No | Called directly from the browser |
| [RainViewer Weather Maps API](https://www.rainviewer.com/api.html) | Radar tiles | No | Free for personal/small-scale use; attribution required and present in `index.html` |
| [Leaflet](https://leafletjs.com/) | Radar map rendering | No | Loaded via CDN |
| [CARTO dark basemap](https://carto.com/basemaps) | Radar map base tiles | No | Free tier, loaded via CDN |
