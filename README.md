# CCTV + Weather Wall — I-26 / US-25 (Arden, NC)

A single always-on webpage for a TV monitor: live NC DOT traffic cameras for
the I-26 / US-25 corridor near Arden, NC, plus live weather (current
conditions, 3-day forecast, animated radar) for Arden, NC. Static
HTML/CSS/JS + one small Worker, deployed free on Cloudflare (Workers with
static assets).

## Status / open TODOs

The DriveNC Cameras API has been called live with a real key and all 12
cameras confirmed working — see [Cameras](#cameras) below for how the
mapping was resolved. Remaining items:

- [x] Confirmed `drivenc.gov/map/Cctv/{id}` viewer pages are iframe-embeddable
      (no blocking `X-Frame-Options`/CSP) — verified visually via the local
      fallback rendering. This is the path used whenever `/api/cameras`
      hasn't responded yet or a stream fails to play.
- [ ] Watch the wall run for a while and confirm 12 simultaneous HLS streams
      don't overload whatever device is driving the TV (a low-power
      stick/smart-TV browser may struggle — if so, consider showing fewer
      live streams at once and cycling the rest, or capping video
      resolution).
- [x] `DRIVENC_API_KEY` is set as a secret on the deployed Worker — see the
      **"Secrets keep disappearing"** note below, this needs periodic
      re-checking, not just a one-time setup step.

Until the key is set in the deployed environment, every tile falls back to
a scaled-down `<iframe>` of its public `drivenc.gov` viewer page, so the
wall is functional even without it. Individual cameras also fall back
per-tile, automatically, whenever their HLS stream fails to start playing
within ~18s (NCDOT's streaming servers have brief, self-resolving blips even
on healthy cameras — confirmed by direct testing, not a bug here) — a
90-second refresh cycle retries and upgrades them back to live video once
the stream recovers.

### Secrets keep disappearing — known Cloudflare bug

`DRIVENC_API_KEY` has been wiped from the Worker's dashboard settings
multiple times during development, each time reverting every camera to the
iframe fallback (`/api/cameras` starts returning `[]` with **HTTP 200** —
that specific response, empty array + status 200 rather than 502, only
comes from the `if (!key)` branch in `src/worker.js`, so it's a reliable
signal the secret is missing).

This matches a known, still-open Cloudflare issue: their built-in Git
integration (the auto-deploy-on-push pipeline this project uses) can wipe
dashboard-set secrets on deploy, even though a normal `wrangler deploy` is
documented to leave secrets untouched. See
[cloudflare/workers-sdk#8871](https://github.com/cloudflare/workers-sdk/issues/8871).
There's no confirmed permanent fix as of this writing.

**If cameras suddenly all show the iframe fallback again:**

1. Check `https://cctv-weather.lboone.workers.dev/api/cameras` — `[]` with
   HTTP 200 confirms the secret is gone (give it ~10s after any dashboard
   change to propagate before concluding it's actually missing).
2. Re-add it: Cloudflare dashboard → the `cctv-weather` Worker → **Settings
   → Variables and Secrets → Add** → Type **Secret**, Name
   `DRIVENC_API_KEY`, paste the value → **Deploy**.
3. If this keeps recurring often enough to be painful, the more durable fix
   is to stop using Cloudflare's dashboard Git integration for deploys and
   instead deploy via a self-managed GitHub Actions workflow
   (`cloudflare/wrangler-action` running a real `wrangler deploy`, with a
   `CLOUDFLARE_API_TOKEN` GitHub Actions secret) — that path is documented
   to actually preserve secrets. Not set up yet; ask if this should be done.

### How the camera IDs were resolved

The GUIDs from the original drivenc.gov URLs (e.g. `07a325cd-ac00-...`)
**do not appear anywhere** in the DriveNC Cameras API response — that GUID
scheme belongs only to the public site's client-side router. The API
identifies cameras by a numeric `Id` instead. The 12 cameras above were
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
- The public DriveNC URL `https://www.drivenc.gov/2da52ce8-5049-4024-8a6d-04b949ca9daa`
  corresponds to `CCTV13-I26-35M` (Id 4839) in the Cameras API; the GUID
  itself is still only a public-site route identifier.

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

## Design

Styled as a DOT traffic-operations console rather than a generic dashboard:
near-black background with a faint blueprint grid + CRT scanline overlay,
HUD-style corner-bracket frames on every camera tile and the radar panel
(cyan by default, amber on the priority tile, red on error), a glowing
instrument-style temperature readout, and a departure-board dot-leader
layout for the 3-day forecast. Typography is Overpass — the FHWA highway
signage typeface family — for display text, Overpass Mono for all data
readouts. Palette roles are intentionally not evenly distributed: amber
marks the header accent/priority feed/alerts, cyan marks
weather/radar/default HUD elements, green and red are reserved strictly for
live/error status dots. Camera tiles fade in with a staggered "boot
sequence" on load. The camera grid is 4 columns of true-16:9 tiles matching
the source video's aspect ratio (so `object-fit: cover` has no edges to crop),
with the priority I-26 / Long Shoals feed rendered as a large 3×3 hero
anchored top-left and the remaining 11 feeds packed around it with no empty
cells. The secondary/tertiary text colors are kept deliberately light so the
eyebrow, panel headers, and forecast text stay legible from across a room on
the TV. See `public/style.css` for the full system.

## Cameras

Priority camera (rendered as a large 3×3 hero, top-left of the grid):

| Label | DriveNC Id | Live stream |
|---|---|---|
| **I-26 MM37 — Long Shoals Rd** | `4208` | ✅ HLS confirmed |

Remaining cameras (all confirmed with live HLS streams as of this writing):

| Label | DriveNC Id | Notes |
|---|---|---|
| I-26 MM35 | `4839` | resolved from public DriveNC GUID `2da52ce8-5049-4024-8a6d-04b949ca9daa` |
| I-26 MM36 | `6120` | |
| I-26 MM39 | `5269` | nearest live camera; exact MM39 unit has no video feed |
| I-26 MM40 | `4210` | |
| I-26 MM41 | `4868` | |
| I-26 MM44 — US-25 | `4876` | |
| I-26 MM45 | `6101` | |
| US-25 — Airport Rd | `4221` | |
| US-25 — Long Shoals Rd | `4224` | |
| US-25 — Gerber Village | `4223` | |
| Airport Rd — Fanning Bridge Rd | `4203` | |

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
npm ci                           # or npm install if updating dependencies
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
