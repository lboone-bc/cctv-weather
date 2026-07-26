import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const expectedCameraIds = [
  4208, 4839, 6120, 5269, 4210, 4868, 4876, 6101, 4221, 4224, 4223, 4203,
];

for (const path of ["public/cameras.js", "public/weather.js", "src/worker.js"]) {
  const result = spawnSync(
    process.execPath,
    ["--check", new URL(path, root).pathname],
    { encoding: "utf8" }
  );
  assert.equal(
    result.status,
    0,
    `${path} failed syntax validation:\n${result.stderr}`
  );
}

const [cameraSource, workerSource, styleSource, wranglerSource] =
  await Promise.all([
    read("public/cameras.js"),
    read("src/worker.js"),
    read("public/style.css"),
    read("wrangler.jsonc"),
  ]);

const cameraBlock = cameraSource.match(
  /const CAMERAS = \[([\s\S]*?)\n\];/
)?.[1];
const workerBlock = workerSource.match(
  /const WANTED_CAMERA_IDS = \[([\s\S]*?)\n\];/
)?.[1];
assert.ok(cameraBlock, "Could not find CAMERAS in public/cameras.js");
assert.ok(workerBlock, "Could not find WANTED_CAMERA_IDS in src/worker.js");

const browserIds = [...cameraBlock.matchAll(/\bid:\s*(\d+)/g)].map((match) =>
  Number(match[1])
);
const workerIds = [...workerBlock.matchAll(/^\s*(\d+),/gm)].map((match) =>
  Number(match[1])
);
assert.deepEqual(
  browserIds,
  expectedCameraIds,
  "Browser camera roster or order changed unexpectedly"
);
assert.deepEqual(
  workerIds,
  expectedCameraIds,
  "Worker camera roster must match the browser order"
);
assert.equal(
  (cameraBlock.match(/priority:\s*true/g) || []).length,
  1,
  "Exactly one camera must be the initial feature"
);
assert.match(
  cameraBlock,
  /^\s*\{ id: 4208,[^\n]+priority: true/m,
  "The Long Shoals camera must remain the initial feature"
);
assert.match(
  styleSource,
  /\.camera-tile\.priority\s*{\s*grid-area: 1 \/ 1 \/ span 3 \/ span 3;/
);
assert.match(cameraSource, /function setFeatureCamera\(nextFeature\)/);
assert.match(
  cameraSource,
  /currentFeature\?\.classList\.remove\("priority"\)/
);
assert.match(cameraSource, /nextFeature\.classList\.add\("priority"\)/);

assert.match(workerSource, /const SIGNED_HLS_MAX_STALE_MS = 15 \* 60_000/);
assert.match(workerSource, /const CAMERA_INVENTORY_TIMEOUT_MS = 15_000/);
assert.match(
  workerSource,
  /const timeout = setTimeout\(\s*\(\) => controller\.abort\(\),\s*CAMERA_INVENTORY_TIMEOUT_MS\s*\)/
);
assert.match(workerSource, /redirect: "manual",\s*signal: controller\.signal/);
assert.match(workerSource, /signedMediaIsWithinMaxAge\(previous, Date\.now\(\)\)/);
assert.match(
  workerSource,
  /refreshAt = Math\.min\(\s*refreshAt,\s*entry\.signedAt \+ SIGNED_HLS_MAX_STALE_MS/
);
assert.match(
  workerSource,
  /signedMediaIsWithinMaxAge\(cached, now\)[\s\S]*\? cached\.data[\s\S]*: unavailableMedia\(media\)/
);
assert.match(workerSource, /mediaMode: "snapshot"/);
assert.match(workerSource, /retryHls:\s*media\.status === "Enabled"/);
assert.match(workerSource, /mediaMode: "hls"/);
assert.match(workerSource, /retryHls: false/);
assert.match(workerSource, /"cache-control": "no-store"/);
assert.doesNotMatch(workerSource, /DRIVENC_(?:USERNAME|PASSWORD)/);

assert.match(cameraSource, /const CAMERA_API_TIMEOUT_MS = 150_000/);
assert.match(
  cameraSource,
  /const requestTimeout = setTimeout\(\s*\(\) => controller\.abort\(\),\s*CAMERA_API_TIMEOUT_MS\s*\)/
);
assert.match(
  cameraSource,
  /fetch\(apiUrl, \{\s*cache: "no-store",\s*signal: controller\.signal/
);
assert.match(cameraSource, /clearTimeout\(requestTimeout\)/);
assert.match(
  cameraSource,
  /renderImage\(tile, data\.imageUrl, \{\s*error: Boolean\(data\.retryHls\)/
);

const wrangler = JSON.parse(wranglerSource);
assert.equal(wrangler.name, "cctv-weather");
assert.equal(
  wrangler.keep_vars,
  true,
  "Dashboard-managed secrets must survive deployments"
);

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const mockCameras = expectedCameraIds.map((id) => ({
  Id: id,
  Views: [
    {
      Status: "Enabled",
      VideoUrl: `https://cfase01.services.ncdot.gov:8887/chan-${id}_l/index.m3u8`,
    },
  ],
}));
const assetsBinding = {
  fetch: () => new Response("not found", { status: 404 }),
};
const workerModuleDataUrl = `data:text/javascript;base64,${Buffer.from(
  workerSource
).toString("base64")}`;

try {
  let simulatedNow = originalDateNow();
  Date.now = () => simulatedNow;
  const failedGrantIds = new Set();

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname === "/api/v2/get/cameras") {
      assert.equal(url.searchParams.get("key"), "test-key");
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal, "Inventory requests must carry an abort signal");
      return Response.json(mockCameras);
    }

    if (url.pathname === "/Camera/GetVideoUrl") {
      const cameraId = Number(url.searchParams.get("imageId"));
      assert.ok(expectedCameraIds.includes(cameraId));
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      if (failedGrantIds.has(cameraId)) {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        token: "00000000-0000-4000-8000-000000000000",
        sourceId: String(cameraId),
        systemSourceId: "Division 13",
      });
    }

    if (url.hostname === "vds.nc.insight-atms.com") {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      const grant = JSON.parse(init.body);
      assert.deepEqual(Object.keys(grant).sort(), [
        "sourceId",
        "systemSourceId",
        "token",
      ]);
      return Response.json(`?token=${"a".repeat(64)}`);
    }

    if (/\.services\.ncdot\.gov$/i.test(url.hostname)) {
      assert.equal(init.redirect, "manual");
      assert.equal(url.searchParams.get("token"), "a".repeat(64));
      return new Response("#EXTM3U\n#EXT-X-VERSION:7\n");
    }

    throw new Error(`Unexpected mocked request: ${url.origin}${url.pathname}`);
  };

  const worker = (
    await import(`${workerModuleDataUrl}#verify-${Date.now()}`)
  ).default;
  const env = {
    ASSETS: assetsBinding,
    DRIVENC_API_KEY: "test-key",
  };

  let payload;
  for (let round = 1; round <= 3; round += 1) {
    const response = await worker.fetch(
      new Request("https://wall.test/api/cameras"),
      env
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    payload = await response.json();
    assert.equal(payload.length, 12);
    assert.equal(
      payload.filter((camera) => camera.hlsAvailable).length,
      round * 4,
      "A cold Worker must progressively sign only four new feeds per call"
    );
    assert.ok(
      payload
        .filter((camera) => !camera.hlsAvailable)
        .every(
          (camera) =>
            camera.mediaMode === "snapshot" &&
            camera.videoUrl === null &&
            camera.retryHls === true
        ),
      "Deferred or failed HLS feeds must be explicit error-state snapshots"
    );
    simulatedNow += 11_000;
  }

  assert.ok(
    payload.every(
      (camera) =>
        camera.mediaMode === "hls" &&
        camera.hlsAvailable === true &&
        camera.retryHls === false &&
        camera.videoUrl?.endsWith(`?token=${"a".repeat(64)}`)
    ),
    "Successful signing must expose only signed HLS media"
  );

  const targetCameraId = expectedCameraIds[0];
  const originalSignedUrl = payload.find(
    (camera) => camera.id === targetCameraId
  ).videoUrl;
  failedGrantIds.add(targetCameraId);

  const retainedResponse = await worker.fetch(
    new Request(
      `https://wall.test/api/cameras?refresh=1&cameraId=${targetCameraId}`
    ),
    env
  );
  const retainedCamera = (await retainedResponse.json()).find(
    (camera) => camera.id === targetCameraId
  );
  assert.equal(
    retainedCamera.videoUrl,
    originalSignedUrl,
    "A recent signed URL may survive a transient renewal failure after reprobe"
  );

  simulatedNow += 15 * 60_000 + 1;
  const expiredResponse = await worker.fetch(
    new Request(
      `https://wall.test/api/cameras?refresh=1&cameraId=${targetCameraId}`
    ),
    env
  );
  const expiredCamera = (await expiredResponse.json()).find(
    (camera) => camera.id === targetCameraId
  );
  assert.equal(expiredCamera.videoUrl, null);
  assert.equal(expiredCamera.hlsAvailable, false);
  assert.equal(expiredCamera.mediaMode, "snapshot");
  assert.equal(expiredCamera.retryHls, true);
  assert.equal(
    expiredCamera.imageUrl,
    `https://www.drivenc.gov/map/Cctv/${targetCameraId}`,
    "An over-age signed URL must be replaced by the public image fallback"
  );
} finally {
  Date.now = originalDateNow;
  globalThis.fetch = originalFetch;
}

console.log(
  "Configuration verified: Arden camera order, click-to-feature layout, bounded refreshes, progressive signed HLS, degraded status, and maximum token age."
);
