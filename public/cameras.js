// Camera list for the I-26 / US-25 corridor near Arden, NC.
//
// `id` is DriveNC's numeric camera Id from their official Cameras API
// (NOT the GUID used in drivenc.gov's public viewer-page URLs — that GUID
// scheme doesn't appear anywhere in the API dataset; these numeric Ids were
// matched by cross-referencing camera location names/coordinates against
// the full API dump. See README for details.)
const CAMERAS = [
  { id: 4208, label: "I-26 MM37 — Long Shoals Rd", priority: true },
  { id: 4839, label: "I-26 MM35" },
  { id: 6120, label: "I-26 MM36" },
  { id: 5269, label: "I-26 MM39" }, // nearest live camera to MM39 (exact MM39 unit has no video feed)
  { id: 4210, label: "I-26 MM40" },
  { id: 4868, label: "I-26 MM41" },
  { id: 4876, label: "I-26 MM44 — US-25" },
  { id: 6101, label: "I-26 MM45" },
  { id: 4221, label: "US-25 — Airport Rd" },
  { id: 4224, label: "US-25 — Long Shoals Rd" },
  { id: 4223, label: "US-25 — Gerber Village" },
  { id: 4203, label: "Airport Rd — Fanning Bridge Rd" },
];

const CAMERA_API_URL = "/api/cameras";
const CAMERA_META_REFRESH_MS = 90_000;
const CAMERA_UNAVAILABLE_RETRY_MS = 10_000;
const CAMERA_API_TIMEOUT_MS = 150_000;
const HLS_CONNECT_TIMEOUT_MS = 18_000;
const HLS_STALL_CHECK_MS = 5_000;
const HLS_STALL_TIMEOUT_MS = 25_000;
let cameraRefreshTimer = null;
let cameraRefreshDueAt = 0;
let cameraRefreshInFlight = false;
const pendingForcedCameraIds = new Set();

function viewerUrl(id) {
  return `https://www.drivenc.gov/map/Cctv/${id}`;
}

function buildTile(cam, index) {
  const tile = document.createElement("div");
  tile.className = "camera-tile" + (cam.priority ? " priority" : "");
  tile.dataset.id = cam.id;
  tile.style.setProperty("--tile-index", index);

  const dot = document.createElement("div");
  dot.className = "status-dot";
  tile.appendChild(dot);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = cam.label;
  tile.appendChild(label);

  const media = document.createElement("div");
  media.className = "media";
  media.style.width = "100%";
  media.style.height = "100%";
  tile.appendChild(media);

  const featureToggle = document.createElement("button");
  featureToggle.className = "feature-toggle";
  featureToggle.type = "button";
  featureToggle.title = cam.priority
    ? `${cam.label} is the feature camera`
    : `Show ${cam.label} as the feature camera`;
  featureToggle.setAttribute("aria-label", featureToggle.title);
  featureToggle.setAttribute("aria-pressed", String(Boolean(cam.priority)));
  featureToggle.addEventListener("click", () => setFeatureCamera(tile));
  tile.appendChild(featureToggle);

  return tile;
}

function setFeatureCamera(nextFeature) {
  const currentFeature = document.querySelector(".camera-tile.priority");
  if (currentFeature === nextFeature) return;

  currentFeature?.classList.remove("priority");
  nextFeature.classList.add("priority");

  document.querySelectorAll(".camera-tile").forEach((tile) => {
    const button = tile.querySelector(".feature-toggle");
    const isFeature = tile === nextFeature;
    const label = tile.querySelector(".label").textContent;
    button.setAttribute("aria-pressed", String(isFeature));
    button.title = isFeature
      ? `${label} is the feature camera`
      : `Show ${label} as the feature camera`;
    button.setAttribute("aria-label", button.title);
  });
}

function disposeTileResources(tile) {
  tile._streamUrl = null;
  const playback = tile._playbackState;
  if (playback) {
    playback.disposed = true;
    clearTimeout(playback.connectTimer);
    clearInterval(playback.stallTimer);
    playback.hls?.destroy();
    playback.video?.pause();
    playback.video?.removeAttribute("src");
    playback.video?.load();
    tile._playbackState = null;
  }

  // A playback-failure retry is tile-scoped and intentionally survives
  // routine image/video renders until its targeted Worker refresh fires.
}

function renderFallbackSnapshot(
  tile,
  { url = viewerUrl(tile.dataset.id), error = false } = {}
) {
  renderImage(tile, url, { error });
}

function renderImage(tile, imageUrl, { error = false } = {}) {
  disposeTileResources(tile);
  tile.classList.toggle("live", !error);
  tile.classList.toggle("error", error);
  const media = tile.querySelector(".media");
  let img = media.querySelector("img");
  if (!img) {
    media.innerHTML = "";
    img = document.createElement("img");
    img.alt = tile.querySelector(".label").textContent;
    img.decoding = "async";
    media.appendChild(img);
  }
  const sep = imageUrl.includes("?") ? "&" : "?";
  img.src = `${imageUrl}${sep}_ts=${Date.now()}`;
}

// NCDOT camera feeds are HLS (.m3u8) live streams. Safari/iOS play HLS
// natively via <video src>; everywhere else needs hls.js (loaded in index.html).
function renderHlsStream(tile, streamUrl) {
  const media = tile.querySelector(".media");
  const existing = media.querySelector("video");
  if (
    existing &&
    tile._streamUrl === streamUrl &&
    tile._playbackState &&
    !tile._playbackState.disposed
  ) {
    return; // already attached to this exact stream, nothing to do
  }

  disposeTileResources(tile);
  media.innerHTML = "";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  tile._streamUrl = streamUrl;
  media.appendChild(video);

  const playback = {
    disposed: false,
    failed: false,
    hls: null,
    video,
    connectTimer: null,
    stallTimer: null,
    lastMediaTime: 0,
    lastProgressAt: Date.now(),
  };
  tile._playbackState = playback;

  // A manifest can parse successfully (or `loadedmetadata` can fire) without
  // a single frame ever actually decoding — a dead or stalled upstream just
  // sits there black forever with no error event. Track both the initial
  // `playing` event and continued media-time progress so a wall left running
  // can recover instead of freezing forever on its last frame.
  const markLive = () => {
    if (playback.disposed || playback.failed) return;
    playback.lastMediaTime = video.currentTime;
    playback.lastProgressAt = Date.now();
    clearTimeout(playback.connectTimer);
    playback.connectTimer = null;
    if (tile._streamRetryTimer) {
      clearTimeout(tile._streamRetryTimer);
      tile._streamRetryTimer = null;
    }
    tile.classList.add("live");
    tile.classList.remove("error");
  };

  const markFailed = (
    reason = "unknown playback failure",
    { retry = true } = {}
  ) => {
    if (playback.disposed || playback.failed) return;
    playback.failed = true;
    console.warn(
      `HLS playback failed/stalled for camera ${tile.dataset.id} (${reason}); ${
        retry ? "retrying shortly" : "using fallback"
      }`
    );
    renderFallbackSnapshot(tile, { error: true });

    if (tile._streamRetryTimer) {
      clearTimeout(tile._streamRetryTimer);
      tile._streamRetryTimer = null;
    }
    if (retry) {
      tile._streamRetryTimer = setTimeout(() => {
        tile._streamRetryTimer = null;
        refreshCameraMetaNow({
          forceHealthCheck: true,
          cameraId: tile.dataset.id,
        });
      }, CAMERA_UNAVAILABLE_RETRY_MS);
    }
  };

  playback.connectTimer = setTimeout(
    () => markFailed("initial connection timeout"),
    HLS_CONNECT_TIMEOUT_MS
  );

  playback.stallTimer = setInterval(() => {
    if (playback.disposed || playback.failed) return;

    // Browsers deliberately throttle or suspend hidden tabs. Reset the
    // baseline while hidden instead of treating normal suspension as a stall.
    if (document.hidden) {
      playback.lastMediaTime = video.currentTime;
      playback.lastProgressAt = Date.now();
      return;
    }

    if (Math.abs(video.currentTime - playback.lastMediaTime) > 0.05) {
      playback.lastMediaTime = video.currentTime;
      playback.lastProgressAt = Date.now();
      return;
    }

    if (Date.now() - playback.lastProgressAt >= HLS_STALL_TIMEOUT_MS) {
      markFailed("no media-time progress");
    }
  }, HLS_STALL_CHECK_MS);

  video.addEventListener("playing", markLive);
  video.addEventListener("error", () =>
    markFailed(video.error?.message || "video element error")
  );

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = streamUrl;
    video.play().catch((err) =>
      markFailed(err?.message || "autoplay rejected")
    );
  } else if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ liveSyncDurationCount: 3 });
    playback.hls = hls;
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () =>
      video.play().catch((err) =>
        markFailed(err?.message || "autoplay rejected")
      )
    );
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) markFailed(`${data.type}: ${data.details}`);
    });
  } else {
    markFailed("HLS playback is unavailable in this browser", {
      retry: false,
    });
  }
}

function scheduleCameraRefresh(delayMs) {
  const safeDelay = Math.max(1_000, delayMs);
  const dueAt = Date.now() + safeDelay;

  // A playback failure may already have scheduled an earlier recovery check.
  // Keep that timer instead of postponing it with a routine token renewal.
  if (cameraRefreshTimer && cameraRefreshDueAt <= dueAt) return;

  if (cameraRefreshTimer) clearTimeout(cameraRefreshTimer);
  cameraRefreshDueAt = dueAt;
  cameraRefreshTimer = setTimeout(() => {
    cameraRefreshTimer = null;
    cameraRefreshDueAt = 0;
    refreshCameraMeta();
  }, safeDelay);
}

async function refreshCameraMeta({
  forceHealthCheck = false,
  cameraId = null,
} = {}) {
  const forceCameraId = String(cameraId ?? "");
  const forceTargetIsValid =
    forceHealthCheck &&
    CAMERAS.some((camera) => String(camera.id) === forceCameraId);

  if (cameraRefreshInFlight) {
    if (forceTargetIsValid) pendingForcedCameraIds.add(forceCameraId);
    return;
  }
  cameraRefreshInFlight = true;

  let payload = [];
  let metadataAvailable = false;
  let nextRefreshMs = CAMERA_UNAVAILABLE_RETRY_MS;
  const controller = new AbortController();
  const requestTimeout = setTimeout(
    () => controller.abort(),
    CAMERA_API_TIMEOUT_MS
  );

  try {
    const params = new URLSearchParams();
    if (forceTargetIsValid) {
      params.set("refresh", "1");
      params.set("cameraId", forceCameraId);
    }
    const query = params.toString();
    const apiUrl = query ? `${CAMERA_API_URL}?${query}` : CAMERA_API_URL;
    const res = await fetch(apiUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`camera API returned ${res.status}`);
    payload = await res.json();
    if (!Array.isArray(payload)) {
      throw new Error("camera API returned an invalid payload");
    }
    metadataAvailable = true;
  } catch (err) {
    console.warn(
      "Camera metadata fetch failed; preserving current tile state:",
      err
    );
  } finally {
    clearTimeout(requestTimeout);
  }

  try {
    if (!metadataAvailable) return;

    nextRefreshMs =
      payload.length === 0
        ? CAMERA_UNAVAILABLE_RETRY_MS
        : CAMERA_META_REFRESH_MS;
    const byId = new Map(
      payload
        .filter((camera) => camera?.id != null)
        .map((camera) => [String(camera.id), camera])
    );

    document.querySelectorAll(".camera-tile").forEach((tile) => {
      const id = tile.dataset.id;
      const data = byId.get(id);
      const hasUsableMedia = data?.hlsAvailable
        ? Boolean(data.videoUrl)
        : Boolean(data?.imageUrl);

      // A partial response must not tear down a stream that is still
      // advancing. Its own fatal-error/stall monitor remains authoritative.
      if (!data || !hasUsableMedia) {
        if (!tile.querySelector("video, img")) {
          renderFallbackSnapshot(tile, {
            url: data?.fallbackUrl || viewerUrl(id),
          });
        }
        nextRefreshMs = Math.min(nextRefreshMs, CAMERA_UNAVAILABLE_RETRY_MS);
        return;
      }

      try {
        // Only the Worker's signed-and-probed availability marker authorizes
        // a video URL. An unsigned NCDOT Basic challenge never reaches media.
        if (data.hlsAvailable && data.videoUrl) {
          renderHlsStream(tile, data.videoUrl);
          const serverRefreshMs = Number(data.refreshAfterMs);
          nextRefreshMs = Math.min(
            nextRefreshMs,
            Number.isFinite(serverRefreshMs)
              ? Math.max(
                  1_000,
                  Math.min(CAMERA_META_REFRESH_MS, serverRefreshMs)
                )
              : CAMERA_META_REFRESH_MS
          );
        } else {
          renderImage(tile, data.imageUrl, {
            error: Boolean(data.retryHls),
          });
          nextRefreshMs = Math.min(
            nextRefreshMs,
            CAMERA_UNAVAILABLE_RETRY_MS
          );
        }
      } catch {
        console.warn(`Failed to render camera ${id}`);
        renderFallbackSnapshot(tile, { error: true });
        nextRefreshMs = Math.min(
          nextRefreshMs,
          CAMERA_UNAVAILABLE_RETRY_MS
        );
      }
    });
  } finally {
    cameraRefreshInFlight = false;

    const pendingCameraId = pendingForcedCameraIds.values().next().value;
    if (pendingCameraId) {
      pendingForcedCameraIds.delete(pendingCameraId);
      void refreshCameraMeta({
        forceHealthCheck: true,
        cameraId: pendingCameraId,
      });
      return;
    }

    scheduleCameraRefresh(nextRefreshMs);
  }
}

function refreshCameraMetaNow({
  forceHealthCheck = false,
  cameraId = null,
} = {}) {
  if (cameraRefreshTimer) clearTimeout(cameraRefreshTimer);
  cameraRefreshTimer = null;
  cameraRefreshDueAt = 0;
  void refreshCameraMeta({ forceHealthCheck, cameraId });
}

function init() {
  const grid = document.getElementById("camera-grid");
  CAMERAS.forEach((cam, index) => {
    grid.appendChild(buildTile(cam, index));
  });

  // Render public DriveNC snapshots immediately, then upgrade only the feeds
  // whose HLS manifests the Worker has verified as healthy.
  document.querySelectorAll(".camera-tile").forEach((tile) => renderFallbackSnapshot(tile));

  refreshCameraMeta();

  window.addEventListener("online", () => refreshCameraMetaNow());
  window.addEventListener("focus", () => refreshCameraMetaNow());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;

    document.querySelectorAll(".camera-tile").forEach((tile) => {
      const playback = tile._playbackState;
      if (!playback || playback.disposed) return;
      playback.lastMediaTime = playback.video.currentTime;
      playback.lastProgressAt = Date.now();
    });
    refreshCameraMetaNow();
  });
}

document.addEventListener("DOMContentLoaded", init);
