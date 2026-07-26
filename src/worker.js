// Single Worker entry point for the Cloudflare deploy pipeline that this
// project's Git integration actually runs (`npx wrangler deploy`), which
// does NOT understand the old Pages-only `/functions` directory convention.
// This Worker does two things:
//   1. Handles GET /api/cameras itself (the DriveNC proxy/cache).
//   2. Falls through to the ASSETS binding for everything else, which
//      serves the static site out of `public/` (configured in
//      wrangler.jsonc).

// DriveNC's official Cameras API uses a numeric `Id` per camera — the GUIDs
// used in drivenc.gov's public viewer-page URLs do NOT appear anywhere in
// this API's data. These Ids were matched by cross-referencing camera
// location names/coordinates against the full API dump (see README).
// Views[0].VideoUrl is an HLS (.m3u8) stream URL. Do not hand that URL to
// the browser until this Worker has fetched and validated its manifest:
// NCDOT's streaming origins can answer with an HTTP Basic-auth challenge,
// which otherwise opens a browser login dialog on the wall.
const WANTED_CAMERA_IDS = [
  4208, // I-26 MM37 — Long Shoals Rd (priority)
  4839, // I-26 MM35
  6120, // I-26 MM36
  5269, // I-26 MM39 (nearest live camera to MM39; exact MM39 unit has no video feed)
  4210, // I-26 MM40
  4868, // I-26 MM41
  4876, // I-26 MM44 — US-25
  6101, // I-26 MM45
  4221, // US-25 — Airport Rd
  4224, // US-25 — Long Shoals Rd
  4223, // US-25 — Gerber Village
  4203, // Airport Rd — Fanning Bridge Rd
];

const CAMERA_META_CACHE_TTL_MS = 90_000;
const HLS_HEALTH_CACHE_TTL_MS = 10_000;
const HLS_PROBE_TIMEOUT_MS = 8_000;

// Module-level caches persist for the lifetime of a given Worker isolate.
// Camera metadata is cached for the browser's normal 90-second cadence so the
// DriveNC API stays comfortably below its rate limit. HLS health is cached for
// only 10 seconds so a newly opened wall cannot receive a long-stale "healthy"
// result after an NCDOT streaming-origin outage begins.
let cameraMetaCache = { data: null, fetchedAt: 0 };
let hlsHealthCache = { data: null, checkedAt: 0 };

function extractMedia(camera) {
  const view = camera.Views?.[0] || {};
  return {
    id: camera.Id,
    videoUrl: view.VideoUrl || null, // live HLS (.m3u8) stream
    imageUrl: null, // none of our selected cameras use a still-image feed; kept for completeness
    viewerUrl: view.Url || null,
    status: view.Status || "Unknown",
  };
}

function fallbackUrl(id) {
  return `https://www.drivenc.gov/map/Cctv/${id}`;
}

async function probeHlsManifest(videoUrl) {
  if (!videoUrl) return false;

  let parsedUrl;
  try {
    parsedUrl = new URL(videoUrl);
  } catch {
    return false;
  }

  // DriveNC supplies these URLs, but still reject unexpected or credential-
  // bearing values before making an outbound request.
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    !parsedUrl.pathname.toLowerCase().endsWith(".m3u8")
  ) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLS_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(parsedUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.1",
      },
    });

    // In particular, never forward an upstream 401 or its WWW-Authenticate
    // header. The browser receives only a boolean availability decision.
    if (!response.ok) return false;

    const manifest = await response.text();
    return manifest.trimStart().startsWith("#EXTM3U");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyHlsAvailability(media) {
  const hlsAvailable =
    media.status === "Enabled" &&
    Boolean(media.videoUrl) &&
    (await probeHlsManifest(media.videoUrl));

  return {
    ...media,
    videoUrl: hlsAvailable ? media.videoUrl : null,
    imageUrl: hlsAvailable ? null : fallbackUrl(media.id),
    fallbackUrl: fallbackUrl(media.id),
    hlsAvailable,
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      // Availability can change independently of camera metadata. The Worker
      // owns both caches; browser/edge caching could strand the wall on a stale
      // direct HLS URL or delay recovery after NCDOT restores service.
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function getCameraMetadata(env, now) {
  const key = env.DRIVENC_API_KEY;
  if (!key) {
    return [];
  }

  if (
    cameraMetaCache.data &&
    now - cameraMetaCache.fetchedAt < CAMERA_META_CACHE_TTL_MS
  ) {
    return cameraMetaCache.data;
  }

  try {
    const upstream = await fetch(
      `https://www.drivenc.gov/api/v2/get/cameras?key=${encodeURIComponent(key)}&format=json`
    );
    if (!upstream.ok) {
      throw new Error(`DriveNC API returned ${upstream.status}`);
    }
    const cameras = await upstream.json();

    const byId = new Map(cameras.map((camera) => [camera.Id, camera]));
    const matched = WANTED_CAMERA_IDS.map((id) => byId.get(id))
      .filter(Boolean)
      .map(extractMedia);

    cameraMetaCache = { data: matched, fetchedAt: now };
    return matched;
  } catch (err) {
    // Stale camera metadata is safe to reuse because every HLS URL is probed
    // again below before it can be returned to the browser.
    if (cameraMetaCache.data) return cameraMetaCache.data;
    throw err;
  }
}

async function handleCamerasApi(env) {
  const now = Date.now();

  try {
    const metadata = await getCameraMetadata(env, now);
    if (!metadata.length) return jsonResponse([]);

    if (
      hlsHealthCache.data &&
      now - hlsHealthCache.checkedAt < HLS_HEALTH_CACHE_TTL_MS
    ) {
      return jsonResponse(hlsHealthCache.data);
    }

    const verified = await Promise.all(metadata.map(verifyHlsAvailability));
    hlsHealthCache = { data: verified, checkedAt: now };
    return jsonResponse(verified);
  } catch {
    // No raw upstream error details are exposed to the browser.
    return jsonResponse([], 502, {
      "x-camera-proxy-error": "upstream-unavailable",
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cameras" && request.method === "GET") {
      return handleCamerasApi(env);
    }

    return env.ASSETS.fetch(request);
  },
};
