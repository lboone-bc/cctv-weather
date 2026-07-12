// Weather + radar for Arden, NC using the free National Weather Service API
// (api.weather.gov, no key required) and RainViewer's free public radar
// tile API (attribution required — see index.html).

const ARDEN_LAT = 35.4429;
const ARDEN_LON = -82.4832;

const WEATHER_REFRESH_MS = 12 * 60_000; // current conditions + forecast
const RADAR_FRAMES_REFRESH_MS = 5 * 60_000; // new radar frame list from RainViewer
const RADAR_ANIMATION_FRAME_MS = 600; // ms between animated radar frames

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function celsiusToFahrenheit(c) {
  return Math.round((c * 9) / 5 + 32);
}

function updateClock() {
  const el = document.getElementById("clock");
  const now = new Date();
  el.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function updateCurrentConditions(pointMeta) {
  const container = document.getElementById("current-conditions");
  const chip = document.getElementById("conditions-chip");

  try {
    const stations = await fetchJson(pointMeta.properties.observationStations);
    const stationUrl = stations.features?.[0]?.id;
    if (!stationUrl) throw new Error("no observation station found");

    const obs = await fetchJson(`${stationUrl}/observations/latest`);
    const p = obs.properties;

    const tempC = p.temperature?.value;
    const tempF = typeof tempC === "number" ? celsiusToFahrenheit(tempC) : null;
    const desc = p.textDescription || "—";
    const windSpeedKmh = p.windSpeed?.value;
    const windMph = typeof windSpeedKmh === "number" ? Math.round(windSpeedKmh * 0.621371) : null;
    const humidity = p.relativeHumidity?.value != null ? Math.round(p.relativeHumidity.value) : null;
    const iconUrl = p.icon || null;

    container.innerHTML = `
      <h2>Arden, NC</h2>
      <div class="current-body">
        ${iconUrl ? `<img class="condition-icon" src="${iconUrl}" alt="${desc}" />` : ""}
        <div class="current-main">
          <div class="temp">${tempF != null ? `${tempF}°F` : "—"}</div>
          <div class="desc">${desc}</div>
          <div class="meta">
            ${windMph != null ? `<span>Wind ${windMph} mph</span>` : ""}
            ${humidity != null ? `<span>Humidity ${humidity}%</span>` : ""}
          </div>
        </div>
      </div>
    `;

    chip.textContent = tempF != null ? `${tempF}°F · ${desc}` : desc;
  } catch (err) {
    console.warn("Current conditions fetch failed:", err);
    container.innerHTML = `<h2>Arden, NC</h2><div class="desc">Current conditions unavailable</div>`;
  }
}

async function updateForecast(pointMeta) {
  const container = document.getElementById("forecast");

  try {
    const forecast = await fetchJson(pointMeta.properties.forecast);
    const periods = forecast.properties.periods.slice(0, 6);

    // Pair day/night periods into up to 3 day rows.
    const days = [];
    for (let i = 0; i < periods.length; i += 2) {
      const day = periods[i];
      const night = periods[i + 1];
      days.push({
        name: day.name,
        short: day.shortForecast,
        hi: day.isDaytime ? day.temperature : night?.temperature,
        lo: !day.isDaytime ? day.temperature : night?.temperature,
      });
    }

    const rows = days
      .slice(0, 3)
      .map(
        (d) => `
      <div class="forecast-day">
        <div class="forecast-day-top">
          <span class="name">${d.name}</span>
          <span class="leader"></span>
          <span class="temps">
            ${d.hi != null ? `<span class="hi">${d.hi}°</span>` : ""}
            ${d.lo != null ? `<span class="lo">${d.lo}°</span>` : ""}
          </span>
        </div>
        <div class="short">${d.short}</div>
      </div>`
      )
      .join("");

    container.innerHTML = `<h2>3-Day Forecast</h2><div class="forecast-days">${rows}</div>`;
  } catch (err) {
    console.warn("Forecast fetch failed:", err);
    container.innerHTML = `<h2>3-Day Forecast</h2><div class="desc">Forecast unavailable</div>`;
  }
}

async function updateWeather() {
  try {
    const pointMeta = await fetchJson(`https://api.weather.gov/points/${ARDEN_LAT},${ARDEN_LON}`);
    await Promise.all([updateCurrentConditions(pointMeta), updateForecast(pointMeta)]);
  } catch (err) {
    console.warn("Weather point lookup failed:", err);
  }
}

// ---- Radar (Leaflet + RainViewer) ----

let radarMap;
let radarFrames = []; // [{ time, layer }]
let radarFrameIndex = 0;
let radarAnimationTimer;

function initRadarMap() {
  radarMap = L.map("radar-map", {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView([ARDEN_LAT, ARDEN_LON], 8);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 12,
  }).addTo(radarMap);

  L.marker([ARDEN_LAT, ARDEN_LON]).addTo(radarMap);

  // The radar panel's size depends on flex/grid layout (plus a staggered
  // entrance animation and webfont swap-in) that may still be settling when
  // this runs, so Leaflet's initial container-size read can be stale —
  // which left the view visibly off-center once layout finished. Keep the
  // map's size/center in sync with its actual rendered container.
  const resizeObserver = new ResizeObserver(() => {
    radarMap.invalidateSize();
    radarMap.setView([ARDEN_LAT, ARDEN_LON], radarMap.getZoom());
  });
  resizeObserver.observe(document.getElementById("radar-map"));
}

async function refreshRadarFrames() {
  try {
    const data = await fetchJson("https://api.rainviewer.com/public/weather-maps.json");
    const past = data.radar?.past || [];
    const frames = past.slice(-6); // last ~6 frames (roughly the past hour)

    radarFrames.forEach((f) => radarMap.removeLayer(f.layer));
    radarFrames = frames.map((frame) => ({
      time: frame.time,
      layer: L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0,
        zIndex: 10,
        // RainViewer only renders real radar tiles up to zoom 7 — past that
        // it serves a "Zoom Level Not Supported" placeholder tile. Capping
        // maxNativeZoom makes Leaflet reuse (and upscale) the zoom-7 tiles
        // at closer map zooms instead of requesting unsupported ones.
        maxNativeZoom: 7,
      }).addTo(radarMap),
    }));

    radarFrameIndex = 0;
    startRadarAnimation();
  } catch (err) {
    console.warn("RainViewer frame list fetch failed:", err);
  }
}

function startRadarAnimation() {
  clearInterval(radarAnimationTimer);
  if (radarFrames.length === 0) return;

  const timeEl = document.getElementById("radar-time");

  const renderFrame = () => {
    radarFrames.forEach((f, i) => f.layer.setOpacity(i === radarFrameIndex ? 0.75 : 0));
    if (timeEl) {
      const label = new Date(radarFrames[radarFrameIndex].time * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      timeEl.textContent = label;
    }
    radarFrameIndex = (radarFrameIndex + 1) % radarFrames.length;
  };

  renderFrame();
  radarAnimationTimer = setInterval(renderFrame, RADAR_ANIMATION_FRAME_MS);
}

// ---- Fullscreen toggle (for driving this off a TV without browser chrome) ----

function initFullscreenToggle() {
  const btn = document.getElementById("fullscreen-toggle");
  if (!btn) return;

  const updateLabel = () => {
    const isFullscreen = !!document.fullscreenElement;
    btn.textContent = isFullscreen ? "⤡" : "⛶";
    const label = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  };

  btn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn("Fullscreen request failed:", err);
      });
    }
  });

  document.addEventListener("fullscreenchange", updateLabel);
  updateLabel();
}

function init() {
  updateClock();
  setInterval(updateClock, 1000);

  updateWeather();
  setInterval(updateWeather, WEATHER_REFRESH_MS);

  initRadarMap();
  refreshRadarFrames();
  setInterval(refreshRadarFrames, RADAR_FRAMES_REFRESH_MS);

  initFullscreenToggle();
}

document.addEventListener("DOMContentLoaded", init);
