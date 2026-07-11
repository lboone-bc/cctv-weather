# CCTV + Weather Wall — I-26 / US-25 (Arden, NC)

A single always-on webpage for a TV monitor: live NC DOT traffic cameras for
the I-26 / US-25 corridor near Arden, NC, plus live weather (current
conditions, 3-day forecast, animated radar) for Arden, NC. Static
HTML/CSS/JS + one small Worker, deployed free on Cloudflare (Workers with
static assets).

## Status / open TODOs

The DriveNC Cameras API has been called live with a real key and all 14
cameras confirmed working — see [Cameras](#cameras) below for how the
mapping was resolved. Remaining items:

- [ ] Verify each camera's `drivenc.gov/map/Cctv/{id}` viewer page is
      actually iframe-embeddable (no blocking `X-Frame-Options`/CSP) — this
      is the fallback path used whenever `/api/cameras` hasn't responded yet
      or a stream fails to play.
- [ ] Watch the wall run for a while and confirm 14 simultaneous HLS streams
      don't overload whatever device is driving the TV (a low-power
      stick/smart-TV browser may struggle — if so, consider showing fewer
      live streams at once and cycling the rest, or capping video
      resolution).
- [ ] Set `DRIVENC_API_KEY` as a secret in the Cloudflare dashboard (see
      Setup below) so the deployed site — not just local dev — gets live
      cameras instead of the iframe fallback.

Until the key is set in the deployed environment, every tile falls back to
an `<iframe>` of its public `drivenc.gov` viewer page, so the wall is
functional out of the box.

### How the camera IDs were resolved

The GUIDs from the original drivenc.gov URLs (e.g. `07a325cd-ac00-...`)
**do not appear anywhere** in the DriveNC Cameras API response — that GUID
scheme belongs only to the public site's client-side router. The API
identifies cameras by a numeric `Id` instead. The 14 cameras above were
matched by pulling the full API dataset (1,153 cameras) and cross-referencing
each requested camera's road/mile-marker/cross-street against the API's
`Location`, `Roadway`, `Direction`, and lat/lon fields for Buncombe and
Henderson counties. Confirmed via a live `curl`:

- Each camera's `Views[0].VideoUrl` is a working, publicly-reachable **HLS
  (.m3u8) live stream** (no auth required) — e.g.
  `https://cfase01.services.ncdot.gov:8887/chan-5378_l/index.m3u8` for I-26
  MM37. `src/worker.js` and `public/cameras.js` were updated accordingly
  (`renderHlsStream()` uses native HLS on Safari, `hls.js` everywhere else).
- The exact "MM39" camera unit (Id 4851) has no video feed populated: the
  nearest live camera (`CCTV13-I26-39.6E`, Id 5269) was used instead.
- "US-25 Old Airport Rd" has its own real camera, `CCTV14-US25_OLDAIRPORT`
  (Id 6103) — distinct from I-26 MM41, resolving the duplicate-GUID issue
  from the original source list.

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
  `public/weather.js`, the latter loading Leaflet + hls.js from CDNs) plus
  one Worker script for the DriveNC proxy. Kept intentionally simple since
  this just needs to run unattended on a TV.

## Cameras

Priority camera (rendered larger, top of the grid):

| Label | DriveNC Id | Live stream |
|---|---|---|
| **I-26 MM37 — Long Shoals Rd** | `4208` | ✅ HLS confirmed |

Remaining cameras (all confirmed with live HLS streams as of this writing):

| Label | DriveNC Id | Notes |
|---|---|---|
| I-26 MM36 | `6120` | |
| I-26 MM39 | `5269` | nearest live camera; exact MM39 unit has no video feed |
| I-26 MM40 | `4210` | |
| I-26 MM41 | `4868` | |
| I-26 MM44 — US-25 | `4876` | |
| I-26 MM45 | `6101` | |
| US-25 — Old Airport Rd | `6103` | resolved from the original duplicate-GUID entry |
| US-25 — Airport Rd | `4221` | |
| US-25 — Long Shoals Rd | `4224` | |
| US-25 — Gerber Village | `4223` | |
| US-25 — Rock Hill Rd | `4227` | |
| Airport Rd — Fanning Bridge Rd | `4203` | |
| Airport Rd — Ferncliff | `6100` | Roadway is tagged NC-280 in DriveNC's data |

Viewer page (iframe fallback) for any camera: `https://www.drivenc.gov/map/Cctv/{id}`.

To add/remove/reorder cameras: edit `CAMERAS` in `public/cameras.js` and
`WANTED_CAMERA_IDS` in `src/worker.js` (both need the numeric DriveNC `Id`;
keep them in sync). Set `priority: true` on at most one camera in
`public/cameras.js` for the large tile. To find a new camera's Id, query the
DriveNC API with a valid key and search by `Location`/`Roadway`/lat-lon —
there's no reliable way to derive it from a drivenc.gov viewer URL.

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
| [hls.js](https://github.com/video-dev/hls.js) | Playing NCDOT's HLS camera streams | No | Loaded via CDN; not needed on Safari/iOS, which play HLS natively |
