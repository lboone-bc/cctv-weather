// Cloudflare Pages Function: GET /api/cameras
//
// Proxies DriveNC's official Cameras API so the DriveNC developer key never
// reaches the browser, and caches the result in-memory so multiple page
// loads / refresh cycles don't blow DriveNC's 10-requests-per-60-seconds
// throttle. Set DRIVENC_API_KEY as a Cloudflare Pages secret env var.
//
// If no key is configured, this returns an empty array (200 OK) rather than
// an error — the front end (cameras.js) treats that as "no data yet" and
// falls back to embedding each camera's public drivenc.gov viewer page in an
// iframe, so the wall still works before the key is set up.

const WANTED_CAMERA_IDS = [
  "07a325cd-ac00-4a93-8a15-478338f71dbd", // I-26 MM37 — Long Shoals Rd (priority)
  "30a32301-7288-42ab-aec5-0686e9198ef6", // I-26 MM36
  "ae534a09-3f42-40b1-b15e-33a07ae8c8ae", // I-26 MM39
  "3d273c12-0bec-40d4-868c-1b8ee5ad434d", // I-26 MM40
  "1682cc9c-c58c-4485-a04b-b603ad8069f0", // I-26 MM41 (also currently mapped to "US-25 Old Airport Rd" — see cameras.js note)
  "35916952-ece1-4fc9-8f86-fbccebf8e3c5", // I-26 MM44 — US-25
  "00bec6b8-bfe4-4f92-81ec-caa12f09fe11", // I-26 MM45
  "081e9880-28ba-4059-a657-bf0094b8b29a", // US-25 — Airport Rd
  "45513374-a881-45f8-871d-1d09b4aa5a54", // US-25 — Long Shoals Rd
  "dc042f71-f086-47cf-aaac-fe5d44accfe2", // US-25 — Gerber Village
  "9e8d51bb-7d76-4230-abbe-5c87f52dce9e", // US-25 — Rock Hill Rd
  "cfb396d1-5a86-4cd6-a73c-eb934f75535e", // Airport Rd — Fanning Bridge Rd
  "32d394f5-36ac-482d-88f7-606327300313", // Airport Rd — Ferncliff
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
    // DriveNC's documented sample data only confirms Views[].Url (a viewer
    // page) and Views[].VideoUrl (often empty for municipal feeds). Field
    // names below are best-guesses for the still-image case and should be
    // confirmed against a real response for these NCDOT cameras, then
    // trimmed to whatever's actually populated.
    videoUrl: view.VideoUrl || camera.VideoUrl || null,
    imageUrl: view.ImageUrl || camera.ImageUrl || view.SnapshotUrl || null,
    viewerUrl: view.Url || null,
    status: view.Status || "Unknown",
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  const now = Date.now();

  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return jsonResponse(cache.data);
  }

  const key = env.DRIVENC_API_KEY;
  if (!key) {
    return jsonResponse([]);
  }

  try {
    const upstream = await fetch(
      `https://www.drivenc.gov/api/v2/get/cameras?key=${encodeURIComponent(key)}&format=json`
    );
    if (!upstream.ok) {
      throw new Error(`DriveNC API returned ${upstream.status}`);
    }
    const body = await upstream.json();
    const cameras = Array.isArray(body) ? body : body.Cameras || body.Result || [];

    const wanted = new Set(WANTED_CAMERA_IDS);
    const matched = cameras
      .filter((c) => wanted.has(String(c.Id)) || wanted.has(String(c.Guid)))
      .map(extractMedia);

    cache = { data: matched, fetchedAt: now };
    return jsonResponse(matched);
  } catch (err) {
    // Serve stale cache if we have it rather than failing the whole tile grid.
    if (cache.data) return jsonResponse(cache.data);
    return jsonResponse([], 502, { "x-camera-proxy-error": String(err) });
  }
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
