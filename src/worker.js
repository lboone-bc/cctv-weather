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
// Views[0].VideoUrl is an unsigned HLS (.m3u8) stream URL. NCDOT's current
// player obtains a signed suffix before requesting that URL.
// Never hand the unsigned URL to the browser: it returns an XEngine HTTP
// Basic-auth challenge and can open a browser login dialog on the wall.
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
const SIGNED_HLS_RENEW_MS = 5 * 60_000;
const SIGNED_HLS_MAX_STALE_MS = 15 * 60_000;
const UNAVAILABLE_HLS_RETRY_MS = 10_000;
const CAMERA_INVENTORY_TIMEOUT_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_CONCURRENT_SIGNING_FLOWS = 3;
// Four worst-case flows (3 grant attempts + 3 token attempts + signed and
// retained-manifest probes) plus one inventory request stay below the
// Workers Free 50-external-subrequest ceiling.
const MAX_SIGNING_FLOWS_PER_REQUEST = 4;
const RATE_LIMIT_RETRY_DELAYS_MS = [250, 750];
const DRIVENC_VIDEO_TOKEN_URL =
  "https://www.drivenc.gov/Camera/GetVideoUrl";
const INSIGHT_SIGNED_URI_URL =
  "https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId";
const NCDOT_HLS_HOST_PATTERN =
  /^cf[a-z0-9-]*\.services\.ncdot\.gov$/i;
const NCDOT_HLS_PATH_PATTERN =
  /^\/chan-[a-z0-9_-]+\/index\.m3u8$/i;

// Module-level caches persist for the lifetime of a given Worker isolate.
// Camera metadata is cached for the browser's normal 90-second cadence so the
// DriveNC developer API stays comfortably below its rate limit. Signed media
// results are cached per camera: healthy URLs renew at five minutes, while
// unavailable cameras retry after 10 seconds.
let cameraMetaCache = { data: null, fetchedAt: 0 };
const signedMediaCache = new Map();
const signedMediaInFlight = new Map();
const signingFlowWaiters = [];
let activeSigningFlows = 0;
let signingSelectionCursor = 0;
let cameraApiRequestInProgress = false;

function extractMedia(camera) {
  const view = camera.Views?.[0] || {};
  return {
    id: camera.Id,
    unsignedVideoUrl: view.VideoUrl || null,
    viewerUrl: view.Url || null,
    status: view.Status || "Unknown",
  };
}

function fallbackUrl(id) {
  return `https://www.drivenc.gov/map/Cctv/${id}`;
}

function parseUnsignedHlsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port !== "8887" ||
    !NCDOT_HLS_HOST_PATTERN.test(url.hostname) ||
    !NCDOT_HLS_PATH_PATTERN.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  return url;
}

function validOpaqueValue(value, maxLength = 4096) {
  return (
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validateVideoTokenRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    typeof value.token === "string" &&
    /^[a-f0-9-]{36}$/i.test(value.token) &&
    validOpaqueValue(value.sourceId, 512) &&
    validOpaqueValue(value.systemSourceId, 512)
  );
}

function buildSignedHlsUrl(unsignedUrl, suffix) {
  if (
    typeof suffix !== "string" ||
    suffix.length < 8 ||
    suffix.length > 8192 ||
    !suffix.startsWith("?") ||
    suffix.includes("#")
  ) {
    return null;
  }

  const signedUrl = new URL(unsignedUrl);
  signedUrl.search = suffix.slice(1);

  return signedHlsUrlMatches(unsignedUrl, signedUrl) ? signedUrl : null;
}

function signedHlsUrlMatches(unsignedUrl, signedUrl) {
  const params = [...signedUrl.searchParams.entries()];
  return !(
    signedUrl.origin !== unsignedUrl.origin ||
    signedUrl.pathname !== unsignedUrl.pathname ||
    signedUrl.username ||
    signedUrl.password ||
    signedUrl.hash ||
    params.length !== 1 ||
    params[0][0] !== "token" ||
    !/^[a-f0-9]{64}$/i.test(params[0][1])
  );
}

function parsePreviouslySignedHlsUrl(value, unsignedValue) {
  const unsignedUrl = parseUnsignedHlsUrl(unsignedValue);
  if (!unsignedUrl) return null;

  let signedUrl;
  try {
    signedUrl = new URL(value);
  } catch {
    return null;
  }

  return signedHlsUrlMatches(unsignedUrl, signedUrl) ? signedUrl : null;
}

async function readBoundedText(response, maxLength) {
  const text = await response.text();
  return text.length <= maxLength ? text : null;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.max(100, Math.min(1_000, retryAfterSeconds * 1_000));
  }
  return RATE_LIMIT_RETRY_DELAYS_MS[attempt];
}

async function fetchBoundedTextWith429Retry(url, init, maxLength) {
  const attempts = RATE_LIMIT_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      UPSTREAM_TIMEOUT_MS
    );
    let delayBeforeRetry = null;

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.status === 429 && attempt < attempts - 1) {
        delayBeforeRetry = retryDelayMs(response, attempt);
        try {
          await response.body?.cancel();
        } catch {
          // Nothing else is needed from a response that will be retried.
        }
      } else {
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            // Ignore cleanup errors for an upstream response we will reject.
          }
          return null;
        }
        return await readBoundedText(response, maxLength);
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }

    await wait(delayBeforeRetry);
  }

  return null;
}

async function withSigningFlowSlot(task) {
  if (activeSigningFlows >= MAX_CONCURRENT_SIGNING_FLOWS) {
    await new Promise((resolve) => signingFlowWaiters.push(resolve));
  } else {
    activeSigningFlows += 1;
  }

  try {
    return await task();
  } finally {
    const next = signingFlowWaiters.shift();
    if (next) {
      // Transfer this occupied slot directly to the next waiter.
      next();
    } else {
      activeSigningFlows -= 1;
    }
  }
}

async function requestSignedHlsUrl(media) {
  if (!WANTED_CAMERA_IDS.includes(media.id) || media.status !== "Enabled") {
    return null;
  }

  const unsignedUrl = parseUnsignedHlsUrl(media.unsignedVideoUrl);
  if (!unsignedUrl) return null;

  const tokenRequestUrl = new URL(DRIVENC_VIDEO_TOKEN_URL);
  tokenRequestUrl.searchParams.set("imageId", String(media.id));

  let tokenRequest;
  try {
    const body = await fetchBoundedTextWith429Retry(
      tokenRequestUrl,
      {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
      },
      16_384
    );
    if (!body) return null;
    tokenRequest = JSON.parse(body);
    if (!validateVideoTokenRequest(tokenRequest)) return null;
  } catch {
    return null;
  }

  try {
    const body = await fetchBoundedTextWith429Retry(
      INSIGHT_SIGNED_URI_URL,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        // DriveNC's player posts these three public grant fields without
        // adding account credentials, cookies, or client-provided fields.
        body: JSON.stringify({
          token: tokenRequest.token,
          sourceId: tokenRequest.sourceId,
          systemSourceId: tokenRequest.systemSourceId,
        }),
      },
      16_384
    );
    if (!body) return null;

    let suffix;
    try {
      suffix = JSON.parse(body);
    } catch {
      suffix = body.trim();
    }

    return buildSignedHlsUrl(unsignedUrl, suffix);
  } catch {
    return null;
  }
}

async function probeHlsManifest(signedUrl) {
  if (!signedUrl) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(signedUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.1",
      },
    });

    // In particular, never forward an upstream 401 or its WWW-Authenticate
    // header. The browser receives only a boolean availability decision.
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cleanup errors for a manifest response we will reject.
      }
      return false;
    }

    const manifest = await response.text();
    return manifest.trimStart().startsWith("#EXTM3U");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function unavailableMedia(media) {
  return {
    id: media.id,
    videoUrl: null,
    imageUrl: fallbackUrl(media.id),
    fallbackUrl: fallbackUrl(media.id),
    viewerUrl: media.viewerUrl,
    status: media.status,
    mediaMode: "snapshot",
    hlsAvailable: false,
    retryHls:
      media.status === "Enabled" && Boolean(media.unsignedVideoUrl),
  };
}

async function verifySignedHls(media) {
  const signedUrl = await requestSignedHlsUrl(media);
  if (!signedUrl || !(await probeHlsManifest(signedUrl))) {
    return unavailableMedia(media);
  }

  return {
    id: media.id,
    // This is the only token-bearing value exposed to the browser, and it is
    // required for HLS playback. It is never logged or included in errors.
    videoUrl: signedUrl.href,
    imageUrl: null,
    fallbackUrl: fallbackUrl(media.id),
    viewerUrl: media.viewerUrl,
    status: media.status,
    mediaMode: "hls",
    hlsAvailable: true,
    retryHls: false,
  };
}

function cachedMediaForResponse(entry, now) {
  let refreshAt =
    entry.renewalRetryAt ||
    entry.checkedAt +
      (entry.data.hlsAvailable
        ? SIGNED_HLS_RENEW_MS
        : UNAVAILABLE_HLS_RETRY_MS);
  if (entry.data.hlsAvailable) {
    refreshAt = Math.min(
      refreshAt,
      entry.signedAt + SIGNED_HLS_MAX_STALE_MS
    );
  }
  return {
    ...entry.data,
    refreshAfterMs: Math.max(1_000, refreshAt - now),
  };
}

function cacheMatchesMedia(entry, media) {
  return (
    entry &&
    entry.unsignedVideoUrl === media.unsignedVideoUrl &&
    entry.status === media.status
  );
}

function signedMediaIsWithinMaxAge(entry, now) {
  return (
    !entry.data.hlsAvailable ||
    (Number.isFinite(entry.signedAt) &&
      now - entry.signedAt < SIGNED_HLS_MAX_STALE_MS)
  );
}

async function refreshSignedMedia(media) {
  const flowStartedAt = Date.now();
  const previous = signedMediaCache.get(media.id);
  const samePreviousSource = cacheMatchesMedia(previous, media);
  const verified = await verifySignedHls(media);

  if (
    !verified.hlsAvailable &&
    samePreviousSource &&
    previous.data.hlsAvailable &&
    signedMediaIsWithinMaxAge(previous, Date.now())
  ) {
    const previousSignedUrl = parsePreviouslySignedHlsUrl(
      previous.data.videoUrl,
      media.unsignedVideoUrl
    );

    // A grant/token renewal failure does not have to interrupt a stream whose
    // older signed URL is still accepted. Reuse it only after an immediate
    // manifest reprobe succeeds, then retry renewal soon.
    if (
      previousSignedUrl &&
      (await probeHlsManifest(previousSignedUrl))
    ) {
      const retained = {
        ...previous,
        lastAttemptAt: Date.now(),
        renewalRetryAt: Date.now() + UNAVAILABLE_HLS_RETRY_MS,
      };
      signedMediaCache.set(media.id, retained);
      return retained;
    }
  }

  const entry = {
    data: verified,
    unsignedVideoUrl: media.unsignedVideoUrl,
    status: media.status,
    checkedAt: flowStartedAt,
    signedAt: verified.hlsAvailable ? Date.now() : 0,
    lastAttemptAt: Date.now(),
    renewalRetryAt: null,
  };
  signedMediaCache.set(media.id, entry);
  return entry;
}

function freshCachedEntry(media, now, { force = false } = {}) {
  const cached = signedMediaCache.get(media.id);
  const cacheTtl = cached?.data.hlsAvailable
    ? SIGNED_HLS_RENEW_MS
    : UNAVAILABLE_HLS_RETRY_MS;
  const forceIsRateLimited =
    force &&
    cached &&
    now - (cached.lastAttemptAt ?? cached.checkedAt) <
      UNAVAILABLE_HLS_RETRY_MS;

  // A playback failure may bypass this camera's otherwise healthy five-minute
  // cache, but never more than once per 10 seconds. Other camera entries keep
  // their independent cache state.
  return (
    cacheMatchesMedia(cached, media) &&
    signedMediaIsWithinMaxAge(cached, now) &&
    ((force && forceIsRateLimited) ||
      (!force &&
        ((cached.renewalRetryAt && now < cached.renewalRetryAt) ||
          (!cached.renewalRetryAt && now - cached.checkedAt < cacheTtl))))
  )
    ? cached
    : null;
}

function matchingInFlightEntry(media) {
  const inFlight = signedMediaInFlight.get(media.id);
  return inFlight &&
    inFlight.unsignedVideoUrl === media.unsignedVideoUrl &&
    inFlight.status === media.status
    ? inFlight
    : null;
}

async function getSignedMedia(media, now, { force = false } = {}) {
  const cached = freshCachedEntry(media, now, { force });
  if (cached) return cachedMediaForResponse(cached, now);

  const inFlight = matchingInFlightEntry(media);
  let entry;
  if (inFlight) {
    entry = await inFlight.promise;
  } else {
    const promise = withSigningFlowSlot(() => refreshSignedMedia(media));
    signedMediaInFlight.set(media.id, {
      promise,
      unsignedVideoUrl: media.unsignedVideoUrl,
      status: media.status,
    });
    try {
      entry = await promise;
    } finally {
      if (signedMediaInFlight.get(media.id)?.promise === promise) {
        signedMediaInFlight.delete(media.id);
      }
    }
  }

  return cachedMediaForResponse(entry, Date.now());
}

function deferredMediaForResponse(media, now) {
  const cached = signedMediaCache.get(media.id);
  const data =
    cacheMatchesMedia(cached, media) &&
    signedMediaIsWithinMaxAge(cached, now)
      ? cached.data
      : unavailableMedia(media);

  return {
    ...data,
    // The browser will ask again quickly, letting the round-robin budget
    // advance through the remaining due cameras without exposing raw media.
    refreshAfterMs: UNAVAILABLE_HLS_RETRY_MS,
  };
}

async function resolveMediaWithinSigningBudget(
  metadata,
  now,
  forceCameraId
) {
  const plans = metadata.map((media, index) => {
    const force = media.id === forceCameraId;
    const cached = freshCachedEntry(media, now, { force });
    if (cached) return { type: "cached", cached, media };

    const inFlight = matchingInFlightEntry(media);
    if (inFlight) return { type: "in-flight", inFlight, media };

    return { type: "due", force, index, media };
  });

  const selectedIndexes = new Set();
  const selectedPlans = [];
  let remainingBudget = MAX_SIGNING_FLOWS_PER_REQUEST;
  const forcedPlan = plans.find(
    (plan) => plan.type === "due" && plan.force
  );
  if (forcedPlan) {
    selectedIndexes.add(forcedPlan.index);
    selectedPlans.push(forcedPlan);
    remainingBudget -= 1;
  }

  const dueIndexes = new Set(
    plans
      .filter((plan) => plan.type === "due")
      .map((plan) => plan.index)
  );
  let lastRoundRobinIndex = null;
  for (
    let offset = 0;
    offset < metadata.length && remainingBudget > 0;
    offset += 1
  ) {
    const index = (signingSelectionCursor + offset) % metadata.length;
    if (!dueIndexes.has(index) || selectedIndexes.has(index)) continue;
    selectedIndexes.add(index);
    selectedPlans.push(plans[index]);
    remainingBudget -= 1;
    lastRoundRobinIndex = index;
  }
  if (lastRoundRobinIndex !== null) {
    signingSelectionCursor =
      (lastRoundRobinIndex + 1) % metadata.length;
  }

  // Start the forced camera before the rotating batch. Result assembly below
  // still follows canonical metadata order.
  const selectedPromises = new Map(
    selectedPlans.map((plan) => [
      plan.index,
      getSignedMedia(plan.media, now, { force: plan.force }),
    ])
  );

  return Promise.all(
    plans.map(async (plan) => {
      if (plan.type === "cached") {
        return cachedMediaForResponse(plan.cached, now);
      }
      if (plan.type === "in-flight") {
        const entry = await plan.inFlight.promise;
        return cachedMediaForResponse(entry, Date.now());
      }
      if (selectedIndexes.has(plan.index)) {
        return selectedPromises.get(plan.index);
      }
      return deferredMediaForResponse(plan.media, now);
    })
  );
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      // Signed HLS URLs are renewable opaque grants. Browser/edge caching
      // could strand the wall on an expired token or delay recovery from a
      // transient failure.
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

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CAMERA_INVENTORY_TIMEOUT_MS
  );

  try {
    const upstream = await fetch(
      `https://www.drivenc.gov/api/v2/get/cameras?key=${encodeURIComponent(key)}&format=json`,
      {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      }
    );
    if (!upstream.ok) {
      try {
        await upstream.body?.cancel();
      } catch {
        // Ignore cleanup errors for an inventory response we will reject.
      }
      throw new Error(`DriveNC API returned ${upstream.status}`);
    }
    const cameras = await upstream.json();
    if (!Array.isArray(cameras)) {
      throw new Error("DriveNC Cameras API returned an invalid payload");
    }

    const byId = new Map(cameras.map((camera) => [camera.Id, camera]));
    const matched = WANTED_CAMERA_IDS.map((id) => {
      const camera = byId.get(id);
      if (!camera || camera.Id !== id) {
        throw new Error("DriveNC Cameras API omitted a configured camera");
      }
      return extractMedia(camera);
    });

    cameraMetaCache = { data: matched, fetchedAt: now };
    return matched;
  } catch (err) {
    // Stale camera metadata is safe to reuse because its unsigned URL never
    // leaves this Worker; only a validated per-camera signed result can.
    if (cameraMetaCache.data) return cameraMetaCache.data;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleCamerasApi(env, { forceCameraId = null } = {}) {
  const now = Date.now();

  try {
    const metadata = await getCameraMetadata(env, now);
    if (!metadata.length) return jsonResponse([]);

    const verified = await resolveMediaWithinSigningBudget(
      metadata,
      now,
      forceCameraId
    );
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
      // Never let overlapping browser/TV polls duplicate a signing burst.
      // The caller keeps its current tiles and retries instead of sharing
      // request-scoped I/O promises between Worker invocations.
      if (cameraApiRequestInProgress) {
        return jsonResponse([], 503, {
          "retry-after": "1",
          "x-camera-proxy-error": "refresh-in-progress",
        });
      }
      cameraApiRequestInProgress = true;

      const requestedCameraId = Number(url.searchParams.get("cameraId"));
      // Invalid or unconfigured IDs degrade to a normal cached read. They can
      // never force an arbitrary upstream signing request.
      const forceHealthCheck =
        url.searchParams.get("refresh") === "1" &&
        WANTED_CAMERA_IDS.includes(requestedCameraId);
      try {
        return await handleCamerasApi(env, {
          forceCameraId: forceHealthCheck ? requestedCameraId : null,
        });
      } finally {
        cameraApiRequestInProgress = false;
      }
    }

    return env.ASSETS.fetch(request);
  },
};
