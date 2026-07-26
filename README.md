# CCTV + Weather Wall — I-26 / US-25 (Arden, NC)

A single always-on webpage for a TV monitor: live NC DOT traffic cameras for
the I-26 / US-25 corridor near Arden, NC, plus live weather (current
conditions, 3-day forecast, animated radar) for Arden, NC. Static
HTML/CSS/JS + one small Worker, deployed free on Cloudflare (Workers with
static assets).

## Status / open TODOs

The DriveNC Cameras API has been called live with a real key and all 12
camera mappings have been confirmed — see [Cameras](#cameras) below for how
the mapping was resolved. HLS availability is intentionally treated as
dynamic. On July 26, 2026, the unsigned URLs in the Cameras API were found to
return `401 Unauthorized` with an `XEngine` HTTP Basic-auth challenge. The
current DriveNC player does not authenticate that challenge with a website
account. Instead, it gets a per-camera token request from DriveNC, exchanges
that object with Insight ATMS for a signed suffix, and appends the
suffix to the unsigned HLS URL. The Worker now performs that same server-side
flow, probes the signed manifest, and gives the browser only a verified signed
URL. Unavailable feeds remain on the public DriveNC image fallback, so the
wall does not open a browser credential dialog. Remaining items:

- [x] Confirmed `drivenc.gov/map/Cctv/{id}` returns a public camera image —
      verified visually via the local fallback rendering. This is the path
      used whenever `/api/cameras`
      hasn't responded yet, signing or manifest validation fails, or a
      verified stream subsequently fails.
- [ ] Watch the wall run for a while and confirm 12 simultaneous HLS streams
      don't overload whatever device is driving the TV (a low-power
      stick/smart-TV browser may struggle — if so, consider showing fewer
      live streams at once and cycling the rest, or capping video
      resolution).
- [x] `DRIVENC_API_KEY` is set as a secret on the deployed Worker — see the
      **"Secrets keep disappearing"** note below, this needs periodic
      re-checking, not just a one-time setup step.

Until the key is set in the deployed environment, every tile falls back to
a public DriveNC camera image, so the wall is functional even without it.
Individual cameras also fall back per-tile whenever signing or the server-side
manifest probe fails, or their verified HLS stream does not start playing
within ~18s. After `playing`, each tile checks `video.currentTime` every five
seconds and treats 25 seconds without media-time progress as a stall. Fatal
video/HLS errors remain active for the full playback attempt. Hidden tabs
reset their progress baseline instead of reporting a false stall when the
browser suspends them.

Healthy signed media is renewed after at most five minutes. Although the
DriveNC bundle contains an optional 60-second renewal loop, that loop is
currently disabled in the live player; a sanitized July 26 test confirmed one
signed token still served its master playlist, media playlist, and segment
after more than 11 minutes. Five minutes is therefore a conservative
application policy, not an observed upstream expiry. A successfully reprobed
older URL can bridge a transient renewal failure, but the Worker never returns
one more than 15 minutes after it was signed. The browser keeps its normal
90-second metadata cadence, shortening only the check that lands immediately
before the five-minute renewal deadline. Camera-inventory requests are bounded
to 15 seconds, and a browser camera-API poll is abandoned after 150 seconds so a
stalled request cannot permanently stop an unattended wall's recovery loop.
An unavailable feed retries after 10 seconds. A playback failure also falls
back immediately and then calls
`/api/cameras?refresh=1&cameraId={configuredId}` after 10 seconds, forcing
only that camera's cached health/signing result to refresh. Concurrent
requests for the same camera coalesce, and the Worker rate-limits forced
bypasses to one per camera per 10 seconds. Click any camera tile to make it
the large feature feed; the existing media player stays attached while the
grid rearranges.

### If an NCDOT/XEngine login prompt appears

Do not enter a DriveNC username or password. The prompt comes from an unsigned
request to NCDOT's separate HLS streaming origin on port 8887. A normal
DriveNC account credential is neither required nor accepted there and must
not be added to Cloudflare. The signing endpoints used by DriveNC's own player
do not require the user's username/password or browser session cookies. This
application uses only the developer API key stored as `DRIVENC_API_KEY` to
fetch camera metadata.

The current code prevents an unsigned 401 URL from reaching the browser. The
Worker validates the configured numeric camera ID and unsigned NCDOT
origin/path, obtains and validates a signed suffix, and requires the signed
manifest to return a 2xx `#EXTM3U` playlist. On any failure,
`/api/cameras` returns that camera with `hlsAvailable: false`,
`videoUrl: null`, and its safe `fallbackUrl`. Responses are `Cache-Control:
no-store`; healthy signed-media results renew by five minutes and unavailable
ones retry after 10 seconds. Signing is cached independently per camera and
limited to three concurrent flows and four due cameras per API invocation. A
transient HTTP 429 from either signing endpoint gets two short,
bounded-backoff retries. If renewal fails, an older signed URL is retained
only when an immediate manifest reprobe proves that it still works and the URL
is less than 15 minutes old; otherwise that tile returns to its public image.
Fallback responses for enabled cameras carry an explicit retry marker so the
wall shows a red error-status dot rather than falsely reporting unavailable
HLS as green/live. Targeted
`refresh=1&cameraId=...` recovery accepts only one of the 12 configured
numeric IDs and bypasses only that camera's cache after the 10-second guard,
so one stalled feed cannot make its 11 healthy peers re-sign. If an
already-open tab predates this fix, close it before opening the updated wall
so its old HLS player cannot continue retrying an unsigned origin.

Cloudflare Workers Free allows 50 external subrequests per invocation. A cold
12-camera request needs 37 subrequests when every signing exchange succeeds,
but two configured 429 retries at both grant endpoints could exceed that
limit. `/api/cameras` therefore signs at most four due cameras per invocation,
always spending the first slot on a valid forced camera. Remaining due
cameras keep previously validated cached media when available, or receive the
safe public image, plus an approximately 10-second refresh hint. A rotating
roster cursor advances the next four-camera batch even when an earlier camera
keeps failing, so a cold wall progressively upgrades all 12 feeds over
several requests instead of exhausting the Worker subrequest budget. Even
the configured worst case—fresh inventory, both grant endpoints retrying
twice, a signed-manifest probe, and an older-manifest reprobe for each of four
cameras—stays at or below 33 external subrequests.
Overlapping `/api/cameras` polls are serialized per Worker isolate. A
collision receives a retryable HTTP 503 `refresh-in-progress` response, and
the browser preserves its current tiles until the next recovery check. The
DriveNC inventory fetch has its own 15-second abort deadline, while the browser
uses a wider 150-second deadline that still accommodates a worst-case bounded
four-camera signing batch.

### Secret retention

`DRIVENC_API_KEY` has been wiped from the Worker's dashboard settings
multiple times during development, each time reverting every camera to the
snapshot fallback (`/api/cameras` starts returning `[]` with **HTTP 200** —
that specific response, empty array + status 200 rather than 502, only
comes from the `if (!key)` branch in `src/worker.js`, so it's a reliable
signal the secret is missing).

`wrangler.jsonc` now sets `keep_vars: true`, which tells Wrangler to preserve
dashboard-managed variables during deployment. Cloudflare also documents that
encrypted secrets should survive normal Wrangler deployments. A prior
Git-integration/version-upload defect was tracked in
[cloudflare/workers-sdk#8871](https://github.com/cloudflare/workers-sdk/issues/8871);
because the key is operationally critical, verify `/api/cameras` after every
release rather than assuming retention.

**If cameras suddenly all show the snapshot fallback again:**

1. Check `https://cctv-weather.lboone.workers.dev/api/cameras` — `[]` with
   HTTP 200 confirms the secret is gone (give it ~10s after any dashboard
   change to propagate before concluding it's actually missing).
2. Re-add it: Cloudflare dashboard → the `cctv-weather` Worker → **Settings
   → Variables and Secrets → Add** → Type **Secret**, Name
   `DRIVENC_API_KEY`, paste the value → **Deploy**.
3. Confirm `keep_vars: true` is still present in `wrangler.jsonc` before any
   deployment. If retention fails again, stop and diagnose the deployment
   path before re-running it.

### How the camera IDs were resolved

The GUIDs from the original drivenc.gov URLs (e.g. `07a325cd-ac00-...`)
**do not appear anywhere** in the DriveNC Cameras API response — that GUID
scheme belongs only to the public site's client-side router. The API
identifies cameras by a numeric `Id` instead. The 12 cameras above were
matched by pulling the full API dataset (1,153 cameras) and cross-referencing
each requested camera's road/mile-marker/cross-street against the API's
`Location`, `Roadway`, `Direction`, and lat/lon fields for Buncombe and
Henderson counties. Confirmed via a live `curl`:

- Each camera's `Views[0].VideoUrl` supplies the unsigned **HLS (.m3u8) live
  stream** base — e.g.
  `https://cfase01.services.ncdot.gov:8887/chan-5378_l/index.m3u8` for I-26
  MM37. Before playback, `src/worker.js` gets the token object from
  `www.drivenc.gov/Camera/GetVideoUrl?imageId={id}`, posts that exact JSON to
  Insight ATMS, appends the returned signed suffix, and validates the signed
  playlist. Only then may `public/cameras.js` call `renderHlsStream()` (which
  uses native HLS on Safari and `hls.js` everywhere else).
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
                     ├── GET .../get/cameras?key=... (server-side only)
                     │        DriveNC Cameras API
                     │
                     ├── GET /Camera/GetVideoUrl?imageId=...
                     │        DriveNC per-camera token request
                     │
                     ├── POST token request JSON
                     │        Insight ATMS signed-URI service
                     │
                     └── GET each signed HLS manifest (health probe)
                              NCDOT streaming origins
```

- **Deployment model:** this repo deploys as a single Cloudflare **Worker
  with static assets** (`wrangler.jsonc`: `main: src/worker.js`,
  `assets.directory: ./public`, `name: cctv-weather`, `keep_vars: true`), not
  the older Pages-Functions (`/functions` directory) convention. Cloudflare's
  Git-integration build
  pipeline for this project runs `npx wrangler deploy`, which needs exactly
  this shape — a single entry-point script plus an assets directory — so
  don't reintroduce a `/functions` folder expecting file-based routing; add
  new server routes as branches inside `src/worker.js`'s `fetch()` instead.
- **Cameras** come from DriveNC's official Cameras REST API, called from
  `src/worker.js` so the API key never reaches the browser and so repeated
  page refreshes across however many TVs are running this don't exceed
  DriveNC's **10 requests / 60 seconds** developer-API rate limit — the
  Worker caches the upstream camera metadata for 90 seconds. For each enabled
  camera it performs DriveNC's current token exchange, accepts only a signed
  URL on the expected NCDOT HTTPS origin/port/path, and exposes it only when
  the manifest is 2xx and begins with `#EXTM3U`. Per-camera healthy signed
  results renew by five minutes and have a hard 15-minute maximum age, with no
  more than three signing flows in flight and no more than four due cameras
  refreshed in one request. The inventory fetch aborts after 15 seconds rather
  than holding the isolate's serialized camera route indefinitely.
  Deferred cameras carry a 10-second retry hint and are selected in rotating
  batches; unavailable feeds also retry after 10 seconds. The browser normally
  asks for metadata every 90 seconds. A tile that fails or stops advancing for
  25 seconds requests a targeted, rate-limited cache bypass after 10 seconds;
  healthy peers keep their cached signed URLs. `/api/cameras` itself is always
  `Cache-Control: no-store`.
- **Weather** (current conditions + forecast) comes straight from the client
  to `api.weather.gov` (NWS) — free, no API key. Flow: `/points/{lat},{lon}`
  → forecast URL + nearest observation station → `/observations/latest`.
- **Radar** uses RainViewer's free public Weather Maps API
  (`api.rainviewer.com/public/weather-maps.json`) for tile URLs, rendered
  with Leaflet on a CARTO dark basemap, animated over the last ~6 frames.
  The frame list refreshes every 5 minutes, while the on-screen animation
  advances every 600ms. RainViewer's free tier is for personal/small-scale
  use and requires the attribution link that's already in `index.html` —
  don't remove it.
- **Weather refresh cadence:** current conditions and forecast reload every
  12 minutes from the browser.
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
with the priority I-26 / Long Shoals feed rendered as the initial large 3×3
hero anchored top-left. Clicking any camera transfers the single hero state
to that tile without rebuilding its media player or changing canonical DOM
order; the remaining 11 feeds repack around it with no empty cells. The
secondary/tertiary text colors are kept deliberately light so the eyebrow,
panel headers, and forecast text stay legible from across a room on the TV.
See `public/style.css` for the full system.

## Cameras

Initial priority camera (rendered as a large 3×3 hero, top-left of the grid):

| Label | DriveNC Id | Live stream |
|---|---|---|
| **I-26 MM37 — Long Shoals Rd** | `4208` | HLS dynamically health-checked |

Remaining selected cameras (all had live HLS streams when originally
verified; current playback depends on the Worker's signing flow and live
manifest probe):

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

Image fallback for any camera: `https://www.drivenc.gov/map/Cctv/{id}`.

To add/remove/reorder cameras: edit `CAMERAS` in `public/cameras.js` and
`WANTED_CAMERA_IDS` in `src/worker.js` (both need the numeric DriveNC `Id`;
keep them in sync). Set `priority: true` on at most one camera in
`public/cameras.js` for the initial large tile; the user can select any other
feature camera at runtime by clicking its tile. To find a new camera's Id,
query the DriveNC API with a valid key and search by
`Location`/`Roadway`/lat-lon — there's no reliable way to derive it from a
drivenc.gov viewer URL.

## Setup

### 1. DriveNC developer API key

1. Register a free account and request a Cameras API key at
   <https://www.drivenc.gov/developers/doc>.
2. Don't put the key in any file in this repo. It's supplied as an
   environment variable (see below).
3. Store only that developer API key in Cloudflare. The signed-HLS exchange
   requires neither a DriveNC account username/password nor browser session
   cookies; do not store either in Worker variables.

### 2. Local development

```bash
npm ci                           # or npm install if updating dependencies
cp .dev.vars.example .dev.vars   # then fill in DRIVENC_API_KEY
npm run dev                      # wrangler dev, serves the Worker + static assets locally
```

(`.dev.vars` is git-ignored — see `.dev.vars.example` for the expected
variable name.)

Before releasing a camera or playback change, run:

```bash
npm run check
npm run deploy -- --dry-run
git diff --check
```

The check exercises the canonical roster and feature-camera layout, progressive
four-camera signing budget, signed/fallback response contract, request
deadlines, and the 15-minute maximum age for a retained token.

### 3. Deploy — Cloudflare

This repo is already connected to Cloudflare's Git integration
(`lboone-bc/cctv-weather` → a Workers project) and deploys on every push to
`main` by running `npx wrangler deploy`, which `wrangler.jsonc` now points at
the existing `cctv-weather` Worker with `src/worker.js` + `./public` assets,
so a direct Wrangler deploy and the Git pipeline target the same production
wall. No dashboard build-settings changes should be needed. One thing to set:

Current production wall:
[cctv-weather.lboone.workers.dev](https://cctv-weather.lboone.workers.dev/),
directly deployed with Wrangler on **2026-07-26** as version
`166acc0f-6e43-4d0a-a4f7-2ea0d8e08e1f`.

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
| DriveNC + Insight ATMS signed-HLS endpoints | Signed camera playback URLs | No account credentials | Server-side token exchange; healthy URLs conservatively renewed by 5 minutes |
| [api.weather.gov](https://www.weather.gov/documentation/services-web-api) (NWS) | Current conditions, 3-day forecast | No | Called directly from the browser |
| [RainViewer Weather Maps API](https://www.rainviewer.com/api.html) | Radar tiles | No | Free for personal/small-scale use; attribution required and present in `index.html` |
| [Leaflet](https://leafletjs.com/) | Radar map rendering | No | Loaded via CDN |
| [CARTO dark basemap](https://carto.com/basemaps) | Radar map base tiles | No | Free tier, loaded via CDN |
| [hls.js](https://github.com/video-dev/hls.js) | Playing NCDOT's HLS camera streams | No | Loaded via CDN; not needed on Safari/iOS, which play HLS natively |
