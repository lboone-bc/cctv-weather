// Camera list for the I-26 / US-25 corridor near Arden, NC.
// `id` is the DriveNC camera GUID (matches the drivenc.gov/{guid} viewer page).
// `viewerUrl` is that public viewer page, used as a fallback if the DriveNC
// Cameras API (proxied via /api/cameras) doesn't return a direct media URL,
// or if the API key hasn't been configured yet.
//
// NOTE: "US-25 Old Airport Rd" was supplied with the exact same GUID as
// "I-26 MM41" (1682cc9c-c58c-4485-a04b-b603ad8069f0). That's almost certainly
// a copy/paste mistake in the source list — both tiles will show the I-26
// MM41 camera until the correct GUID is supplied for Old Airport Rd.
const CAMERAS = [
  { id: "07a325cd-ac00-4a93-8a15-478338f71dbd", label: "I-26 MM37 — Long Shoals Rd", priority: true },
  { id: "30a32301-7288-42ab-aec5-0686e9198ef6", label: "I-26 MM36" },
  { id: "ae534a09-3f42-40b1-b15e-33a07ae8c8ae", label: "I-26 MM39" },
  { id: "3d273c12-0bec-40d4-868c-1b8ee5ad434d", label: "I-26 MM40" },
  { id: "1682cc9c-c58c-4485-a04b-b603ad8069f0", label: "I-26 MM41" },
  { id: "35916952-ece1-4fc9-8f86-fbccebf8e3c5", label: "I-26 MM44 — US-25" },
  { id: "00bec6b8-bfe4-4f92-81ec-caa12f09fe11", label: "I-26 MM45" },
  { id: "1682cc9c-c58c-4485-a04b-b603ad8069f0", label: "US-25 — Old Airport Rd (verify GUID — duplicate of MM41)" },
  { id: "081e9880-28ba-4059-a657-bf0094b8b29a", label: "US-25 — Airport Rd" },
  { id: "45513374-a881-45f8-871d-1d09b4aa5a54", label: "US-25 — Long Shoals Rd" },
  { id: "dc042f71-f086-47cf-aaac-fe5d44accfe2", label: "US-25 — Gerber Village" },
  { id: "9e8d51bb-7d76-4230-abbe-5c87f52dce9e", label: "US-25 — Rock Hill Rd" },
  { id: "cfb396d1-5a86-4cd6-a73c-eb934f75535e", label: "Airport Rd — Fanning Bridge Rd" },
  { id: "32d394f5-36ac-482d-88f7-606327300313", label: "Airport Rd — Ferncliff" },
];

const CAMERA_API_URL = "/api/cameras";
const CAMERA_META_REFRESH_MS = 90_000; // how often we re-ask the proxy for fresh media URLs
const IMAGE_REFRESH_MS = 8_000; // how often we bust the cache on a still-image feed

function viewerUrl(id) {
  return `https://www.drivenc.gov/${id}`;
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

function renderStream(tile, streamUrl) {
  // Treat as an MJPEG-style stream an <img> tag can consume directly.
  // (True HLS/.m3u8 sources would need hls.js — add if a DriveNC camera
  // turns out to return one; none confirmed as of writing.)
  tile.classList.add("live");
  tile.classList.remove("error");
  const media = tile.querySelector(".media");
  let img = media.querySelector("img.stream");
  if (!img) {
    media.innerHTML = "";
    img = document.createElement("img");
    img.className = "stream";
    img.alt = tile.querySelector(".label").textContent;
    media.appendChild(img);
  }
  img.src = streamUrl;
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

  const byId = new Map(payload.map((c) => [c.id, c]));

  document.querySelectorAll(".camera-tile").forEach((tile) => {
    const id = tile.dataset.id;
    const data = byId.get(id);

    if (!data || (!data.videoUrl && !data.imageUrl)) {
      renderFallbackIframe(tile);
      return;
    }

    try {
      if (data.videoUrl) {
        renderStream(tile, data.videoUrl);
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

function bustImageCaches() {
  document.querySelectorAll(".camera-tile.live img:not(.stream)").forEach((img) => {
    const [base] = img.src.split("?_ts=");
    img.src = `${base}?_ts=${Date.now()}`;
  });
}

function init() {
  const grid = document.getElementById("camera-grid");
  for (const cam of CAMERAS) {
    grid.appendChild(buildTile(cam));
  }

  // Render fallback iframes immediately so the wall is useful the instant
  // it loads, then upgrade tiles to live media once /api/cameras responds.
  document.querySelectorAll(".camera-tile").forEach(renderFallbackIframe);

  refreshCameraMeta();
  setInterval(refreshCameraMeta, CAMERA_META_REFRESH_MS);
  setInterval(bustImageCaches, IMAGE_REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);
