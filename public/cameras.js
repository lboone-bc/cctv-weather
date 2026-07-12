// Camera list for the I-26 / US-25 corridor near Arden, NC.
//
// `id` is DriveNC's numeric camera Id from their official Cameras API
// (NOT the GUID used in drivenc.gov's public viewer-page URLs — that GUID
// scheme doesn't appear anywhere in the API dataset; these numeric Ids were
// matched by cross-referencing camera location names/coordinates against
// the full API dump. See README for details.)
const CAMERAS = [
  { id: 4208, label: "I-26 MM37 — Long Shoals Rd", priority: true },
  { id: 6120, label: "I-26 MM36" },
  { id: 5269, label: "I-26 MM39" }, // nearest live camera to MM39 (exact MM39 unit has no video feed)
  { id: 4210, label: "I-26 MM40" },
  { id: 4868, label: "I-26 MM41" },
  { id: 4876, label: "I-26 MM44 — US-25" },
  { id: 6101, label: "I-26 MM45" },
  { id: 6103, label: "US-25 — Old Airport Rd" },
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

  return tile;
}

// The drivenc.gov viewer page renders at its own natural desktop size —
// embedded at 100%/100% it just shows an unscaled, cropped fragment (the
// page's own oversized header text filling the whole tile). Instead, size
// the iframe to that natural viewport and scale the whole thing down to
// cover the tile, so it reads as "a small view of their page" rather than
// "zoomed into one corner of it".
const IFRAME_NATURAL_WIDTH = 1600;
const IFRAME_NATURAL_HEIGHT = 1000;

function renderFallbackIframe(tile) {
  const id = tile.dataset.id;
  tile.classList.remove("live", "error");
  const media = tile.querySelector(".media");
  media.innerHTML = "";

  const iframe = document.createElement("iframe");
  iframe.src = viewerUrl(id);
  iframe.loading = "lazy";
  iframe.title = tile.querySelector(".label").textContent;
  Object.assign(iframe.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: `${IFRAME_NATURAL_WIDTH}px`,
    height: `${IFRAME_NATURAL_HEIGHT}px`,
    transformOrigin: "top left",
    border: "0",
  });
  media.appendChild(iframe);

  const scaleToFit = () => {
    const rect = tile.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.max(rect.width / IFRAME_NATURAL_WIDTH, rect.height / IFRAME_NATURAL_HEIGHT);
    iframe.style.transform = `scale(${scale})`;
  };
  scaleToFit();

  // Tile size can change (grid reflow on load, priority tile is 3x3, etc.);
  // keep the scale in sync rather than computing it once and going stale.
  if (tile._fallbackResizeObserver) tile._fallbackResizeObserver.disconnect();
  const ro = new ResizeObserver(scaleToFit);
  ro.observe(tile);
  tile._fallbackResizeObserver = ro;
}

function renderImage(tile, imageUrl) {
  tile.classList.add("live");
  tile.classList.remove("error");
  const media = tile.querySelector(".media");
  let img = media.querySelector("img");
  if (!img) {
    media.innerHTML = "";
    img = document.createElement("img");
    img.alt = tile.querySelector(".label").textContent;
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

  media.innerHTML = "";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.dataset.src = streamUrl;
  media.appendChild(video);

  let settled = false;

  // A manifest can parse successfully (or `loadedmetadata` can fire) without
  // a single frame ever actually decoding — a dead or stalled upstream just
  // sits there black forever with no error event. Only trust an explicit
  // `playing` event as "actually live", and give it a window to get there
  // before giving up and falling back to the viewer iframe.
  const markLive = () => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    tile.classList.add("live");
    tile.classList.remove("error");
  };
  const markFailed = () => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    console.warn(`HLS playback failed/stalled for camera ${tile.dataset.id}, falling back to viewer iframe`);
    markError(tile);
    renderFallbackIframe(tile);
  };

  const watchdog = setTimeout(markFailed, HLS_CONNECT_TIMEOUT_MS);

  video.addEventListener("playing", markLive);
  video.addEventListener("error", markFailed, { once: true });

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = streamUrl;
    video.play().catch(() => {});
  } else if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ liveSyncDurationCount: 3 });
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

    if (!data || (!data.videoUrl && !data.imageUrl)) {
      renderFallbackIframe(tile);
      return;
    }

    try {
      if (data.videoUrl) {
        renderHlsStream(tile, data.videoUrl);
      } else {
        renderImage(tile, data.imageUrl);
      }
    } catch (err) {
      console.warn(`Failed to render camera ${id}:`, err);
      markError(tile);
      renderFallbackIframe(tile);
    }
  });
}

function init() {
  const grid = document.getElementById("camera-grid");
  CAMERAS.forEach((cam, index) => {
    grid.appendChild(buildTile(cam, index));
  });

  // Render fallback iframes immediately so the wall is useful the instant
  // it loads, then upgrade tiles to live HLS streams once /api/cameras responds.
  document.querySelectorAll(".camera-tile").forEach(renderFallbackIframe);

  refreshCameraMeta();
  setInterval(refreshCameraMeta, CAMERA_META_REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);
