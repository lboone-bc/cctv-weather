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
const CAMERA_META_REFRESH_MS = 90_000; // how often we re-ask the proxy for fresh media URLs

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

function stopTilePlayback(tile) {
  tile._playbackGeneration = (tile._playbackGeneration || 0) + 1;

  if (tile._hlsWatchdog) {
    clearTimeout(tile._hlsWatchdog);
    tile._hlsWatchdog = null;
  }

  if (tile._hls) {
    tile._hls.destroy();
    tile._hls = null;
  }

  const video = tile.querySelector(".media video");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

function renderFallbackSnapshot(tile, safeFallbackUrl = viewerUrl(tile.dataset.id)) {
  renderImage(tile, safeFallbackUrl);
}

function renderImage(tile, imageUrl) {
  tile.classList.add("live");
  tile.classList.remove("error");
  stopTilePlayback(tile);
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

// NCDOT's streaming servers have brief (few-second) manifest/segment blips
// fairly often even on healthy cameras; give hls.js's own internal retry
// backoff room to ride those out before we give up on this attempt.
const HLS_CONNECT_TIMEOUT_MS = 18_000;

// NCDOT camera feeds are HLS (.m3u8) live streams. Safari/iOS play HLS
// natively via <video src>; everywhere else needs hls.js (loaded in index.html).
function renderHlsStream(tile, streamUrl) {
  const media = tile.querySelector(".media");
  const existing = media.querySelector("video");
  if (existing && existing.dataset.src === streamUrl) {
    return; // already attached to this exact stream, nothing to do
  }

  stopTilePlayback(tile);
  const playbackGeneration = tile._playbackGeneration;
  media.innerHTML = "";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.dataset.src = streamUrl;
  media.appendChild(video);

  let failed = false;

  // A manifest can parse successfully (or `loadedmetadata` can fire) without
  // a single frame ever actually decoding — a dead or stalled upstream just
  // sits there black forever with no error event. Only trust an explicit
  // `playing` event as "actually live", and give it a window to get there
  // before giving up and falling back to the viewer iframe.
  const markLive = () => {
    if (failed || tile._playbackGeneration !== playbackGeneration) return;
    clearTimeout(tile._hlsWatchdog);
    tile._hlsWatchdog = null;
    tile.classList.add("live");
    tile.classList.remove("error");
  };
  const markFailed = () => {
    if (failed || tile._playbackGeneration !== playbackGeneration) return;
    failed = true;
    clearTimeout(tile._hlsWatchdog);
    tile._hlsWatchdog = null;
    console.warn(`HLS playback failed/stalled for camera ${tile.dataset.id}, falling back to snapshot`);
    markError(tile);
    renderFallbackSnapshot(tile);
  };

  tile._hlsWatchdog = setTimeout(markFailed, HLS_CONNECT_TIMEOUT_MS);

  video.addEventListener("playing", markLive);
  video.addEventListener("error", markFailed, { once: true });

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = streamUrl;
    video.play().catch(() => {});
  } else if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ liveSyncDurationCount: 3 });
    tile._hls = hls;
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) markFailed();
    });
  } else {
    markFailed();
  }
}

function markError(tile) {
  tile.classList.add("error");
  tile.classList.remove("live");
}

async function refreshCameraMeta() {
  let payload = [];
  try {
    const res = await fetch(CAMERA_API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`camera API returned ${res.status}`);
    payload = await res.json();
  } catch (err) {
    console.warn("Camera metadata fetch failed, using viewer-page fallback for all tiles:", err);
    payload = [];
  }

  const byId = new Map(payload.map((c) => [String(c.id), c]));

  document.querySelectorAll(".camera-tile").forEach((tile) => {
    const id = tile.dataset.id;
    const data = byId.get(id);

    // `hlsAvailable: true` is the Worker's explicit attestation that it just
    // received a valid 2xx HLS manifest. Never trust a raw videoUrl without
    // that marker; this prevents an NCDOT HTTP Basic challenge from reaching
    // the browser when its streaming origins are unavailable.
    if (!data || (!data.hlsAvailable && !data.imageUrl)) {
      renderFallbackSnapshot(tile, data?.fallbackUrl || viewerUrl(id));
      return;
    }

    try {
      if (data.hlsAvailable && data.videoUrl) {
        renderHlsStream(tile, data.videoUrl);
      } else {
        renderImage(tile, data.imageUrl);
      }
    } catch (err) {
      console.warn(`Failed to render camera ${id}:`, err);
      markError(tile);
      renderFallbackSnapshot(tile);
    }
  });
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
  setInterval(refreshCameraMeta, CAMERA_META_REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);
