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
// Confirmed field: Views[0].VideoUrl is a live HLS (.m3u8) stream.
const WANTED_CAMERA_IDS = [
  4208, // I-26 MM37 — Long Shoals Rd (priority)
  6120, // I-26 MM36
  5269, // I-26 MM39 (nearest live camera to MM39; exact MM39 unit has no video feed)
  4210, // I-26 MM40
  4868, // I-26 MM41
  4876, // I-26 MM44 — US-25
  6101, // I-26 MM45
  6103, // US-25 — Old Airport Rd
  4221, // US-25 — Airport Rd
  4224, // US-25 — Long Shoals Rd
  4223, // US-25 — Gerber Village
  4227, // US-25 — Rock Hill Rd
  4203, // Airport Rd — Fanning Bridge Rd
  6100, // Airport Rd — Ferncliff
];

const CACHE_TTL_MS = 90_000;

// Module-level cache. Persists for the lifetime of a given Worker isolate —
// not guaranteed across every request, but in practice avoids most redundant
// upstream calls between the ~90s refresh cycles the front end uses.
let cache = { data: null, fetchedAt: 0 };

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

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
      ...extraHeaders,
    },
  });
}

async function handleCamerasApi(env) {
  const now = Date.now();

  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return jsonResponse(cache.data);
  }

  const key = env.DRIVENC_API_KEY;
  if (!key) {
    // No key configured yet: front end falls back to per-camera viewer-page
    // iframes when this returns an empty array, so the wall stays usable.
    return jsonResponse([]);
  }

  try {
    const upstream = await fetch(
      `https://www.drivenc.gov/api/v2/get/cameras?key=${encodeURIComponent(key)}&format=json`
    );
    if (!upstream.ok) {
      throw new Error(`DriveNC API returned ${upstream.status}`);
    }
    const cameras = await upstream.json();

    const wanted = new Set(WANTED_CAMERA_IDS);
    const matched = cameras.filter((c) => wanted.has(c.Id)).map(extractMedia);

    cache = { data: matched, fetchedAt: now };
    return jsonResponse(matched);
  } catch (err) {
    // Serve stale cache if we have it rather than failing the whole tile grid.
    if (cache.data) return jsonResponse(cache.data);
    return jsonResponse([], 502, { "x-camera-proxy-error": String(err) });
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
