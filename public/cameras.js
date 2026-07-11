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
  { id: 4227, label: "US-25 — Rock Hill Rd" },
  { id: 4203, label: "Airport Rd — Fanning Bridge Rd" },
  { id: 6100, label: "Airport Rd — Ferncliff" },
];

const CAMERA_API_URL = "/api/cameras";
const CAMERA_META_REFRESH_MS = 90_000; // how often we re-ask the proxy for fresh media URLs

function viewerUrl(id) {
  return `https://www.drivenc.gov/map/Cctv/${id}`;
}

function buildTile(cam) {
  const tile = document.createElement("div");
  tile.className = "camera-tile" + (cam.priority ? " priority" : "");
  tile.dataset.id = cam.id;

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

function renderFallbackIframe(tile) {
  const id = tile.dataset.id;
  tile.classList.remove("live", "error");
  const media = tile.querySelector(".media");
  media.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = viewerUrl(id);
  iframe.loading = "lazy";
  iframe.title = tile.querySelector(".label").textContent;
  media.appendChild(iframe);
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

// NCDOT camera feeds are HLS (.m3u8) live streams. Safari/iOS play HLS
// natively via <video src>; everywhere else needs hls.js (loaded in index.html).
function renderHlsStream(tile, streamUrl) {
  const media = tile.querySelector(".media");
  const existing = media.querySelector("video");
  if (existing && existing.dataset.src === streamUrl) {
    return; // already playing this exact stream, nothing to do
  }

  media.innerHTML = "";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.dataset.src = streamUrl;
  media.appendChild(video);

  const markLive = () => {
    tile.classList.add("live");
    tile.classList.remove("error");
  };
  const markFailed = () => {
    console.warn(`HLS playback failed for camera ${tile.dataset.id}, falling back to viewer iframe`);
    markError(tile);
    renderFallbackIframe(tile);
  };

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = streamUrl;
    video.addEventListener("loadedmetadata", markLive, { once: true });
    video.addEventListener("error", markFailed, { once: true });
  } else if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ liveSyncDurationCount: 3 });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, markLive);
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
  for (const cam of CAMERAS) {
    grid.appendChild(buildTile(cam));
  }

  // Render fallback iframes immediately so the wall is useful the instant
  // it loads, then upgrade tiles to live HLS streams once /api/cameras responds.
  document.querySelectorAll(".camera-tile").forEach(renderFallbackIframe);

  refreshCameraMeta();
  setInterval(refreshCameraMeta, CAMERA_META_REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);
