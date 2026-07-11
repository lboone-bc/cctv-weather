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
  el.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

    container.innerHTML = `
      <h2>Arden, NC</h2>
      <div class="temp">${tempF != null ? `${tempF}°F` : "—"}</div>
      <div class="desc">${desc}</div>
      <div class="meta">
        ${windMph != null ? `<span>Wind ${windMph} mph</span>` : ""}
        ${humidity != null ? `<span>Humidity ${humidity}%</span>` : ""}
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
        <span class="name">${d.name}</span>
        <span class="short">${d.short}</span>
        <span class="temps">
          ${d.hi != null ? `<span class="hi">${d.hi}°</span>` : ""}
          ${d.lo != null ? `<span class="lo">${d.lo}°</span>` : ""}
        </span>
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
let radarLayers = [];
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
  }).setView([ARDEN_LAT, ARDEN_LON], 7);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 12,
  }).addTo(radarMap);

  L.marker([ARDEN_LAT, ARDEN_LON]).addTo(radarMap);
}

async function refreshRadarFrames() {
  try {
    const data = await fetchJson("https://api.rainviewer.com/public/weather-maps.json");
    const past = data.radar?.past || [];
    const frames = past.slice(-6); // last ~6 frames (roughly the past hour)

    radarLayers.forEach((layer) => radarMap.removeLayer(layer));
    radarLayers = frames.map((frame) =>
      L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0,
        zIndex: 10,
      }).addTo(radarMap)
    );

    radarFrameIndex = 0;
    startRadarAnimation();
  } catch (err) {
    console.warn("RainViewer frame list fetch failed:", err);
  }
}

function startRadarAnimation() {
  clearInterval(radarAnimationTimer);
  if (radarLayers.length === 0) return;

  radarAnimationTimer = setInterval(() => {
    radarLayers.forEach((layer, i) => layer.setOpacity(i === radarFrameIndex ? 0.75 : 0));
    radarFrameIndex = (radarFrameIndex + 1) % radarLayers.length;
  }, RADAR_ANIMATION_FRAME_MS);
}

function init() {
  updateClock();
  setInterval(updateClock, 1000);

  updateWeather();
  setInterval(updateWeather, WEATHER_REFRESH_MS);

  initRadarMap();
  refreshRadarFrames();
  setInterval(refreshRadarFrames, RADAR_FRAMES_REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);
