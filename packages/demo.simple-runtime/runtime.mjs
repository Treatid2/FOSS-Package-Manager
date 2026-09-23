// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const width = 960;
const height = 640;

const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const scale = (a, amount) => a.map((value) => value * amount);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a) => scale(a, 1 / Math.sqrt(dot(a, a)));

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function shade(colour, factor) {
  const channels = colour.map((channel) => Math.max(0, Math.min(255, Math.round(channel * factor))));
  return `rgb(${channels.join(",")})`;
}

export function renderSvg(scene) {
  const camera = scene.camera;
  const forward = normalize(subtract(camera.target, camera.position));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const focal = (height / 2) / Math.tan((camera.fieldOfViewDegrees * Math.PI / 180) / 2);
  const project = (point) => {
    const relative = subtract(point, camera.position);
    const depth = dot(relative, forward);
    return {
      x: width / 2 + dot(relative, right) * focal / depth,
      y: height / 2 - dot(relative, up) * focal / depth,
      depth,
    };
  };

  const faceDefinitions = [
    { indices: [0, 1, 2, 3], shade: 0.72 },
    { indices: [4, 7, 6, 5], shade: 1.08 },
    { indices: [0, 4, 5, 1], shade: 0.83 },
    { indices: [1, 5, 6, 2], shade: 0.94 },
    { indices: [2, 6, 7, 3], shade: 0.64 },
    { indices: [3, 7, 4, 0], shade: 0.78 },
  ];
  const faces = [];
  for (const object of scene.objects) {
    const half = object.size.map((value) => value / 2);
    const vertices = [
      [-half[0], -half[1], -half[2]], [half[0], -half[1], -half[2]],
      [half[0], half[1], -half[2]], [-half[0], half[1], -half[2]],
      [-half[0], -half[1], half[2]], [half[0], -half[1], half[2]],
      [half[0], half[1], half[2]], [-half[0], half[1], half[2]],
    ].map((vertex) => add(vertex, object.position)).map(project);
    for (const face of faceDefinitions) {
      const points = face.indices.map((index) => vertices[index]);
      if (points.some((point) => point.depth <= 0.05)) continue;
      faces.push({
        object,
        points,
        depth: points.reduce((sum, point) => sum + point.depth, 0) / points.length,
        fill: shade(object.colour, face.shade),
      });
    }
  }
  faces.sort((a, b) => b.depth - a.depth);
  const polygons = faces.map((face) => {
    const points = face.points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    return `<polygon points="${points}" fill="${face.fill}" stroke="rgba(16,27,33,.42)" stroke-width="1.2"><title>${escapeXml(face.object.id)}</title></polygon>`;
  }).join("\n");
  const selectedHead = scene.objects.find((object) => object.part === "head")?.sources.textureBinding;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Resolved FOSS Package Manager demo scene">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9fc7d7"/><stop offset="1" stop-color="#dce7df"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <circle cx="805" cy="98" r="42" fill="#fff2bd" opacity=".85"/>
  ${polygons}
  <g font-family="Segoe UI, sans-serif" fill="#142027">
    <text x="28" y="42" font-size="25" font-weight="700">FOSS Package Manager</text>
    <text x="28" y="68" font-size="15">${escapeXml(scene.profile)} · immutable scene snapshot · transform revision ${escapeXml(scene.runtime?.transformRevision ?? "built")}</text>
    <text x="28" y="612" font-size="13">Head binding: ${escapeXml(selectedHead?.selected ?? "unknown")} (${escapeXml(selectedHead?.reason ?? "unknown")})</text>
  </g>
</svg>`;
}

function html(scene, svg, live = true) {
  const rows = scene.objects.map((object) => `<li><strong>${escapeXml(object.id)}</strong><span>${escapeXml(object.sources.textureBinding.selected)}</span></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FGPM · ${escapeXml(scene.profile)}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#11191e;color:#e8f0ed;font:15px/1.45 Segoe UI,sans-serif;display:grid;grid-template-columns:minmax(0,960px) 320px;min-height:100vh;align-items:start}main{padding:24px}svg{display:block;width:100%;height:auto;border-radius:14px;box-shadow:0 18px 70px #0008}aside{padding:30px 24px;border-left:1px solid #ffffff18;min-height:100vh;background:#172228}h1{font-size:19px;margin:0 0 8px}p{color:#a9bbb4;margin:0 0 26px}ul{list-style:none;padding:0;margin:0}li{padding:13px 0;border-top:1px solid #ffffff13}li strong,li span{display:block;overflow-wrap:anywhere}li span{color:#80c99a;font-size:12px;margin-top:5px}@media(max-width:900px){body{display:block}aside{min-height:auto;border-left:0}main{padding:12px}}
  </style></head><body><main><div id="scene-frame">${svg}</div></main><aside><h1>Resolved scene</h1><p>The renderer knows this immutable flat snapshot only. Package discovery, handler dispatch, replacement resolution, and authoritative transform mutation happen elsewhere.</p><ul>${rows}</ul></aside>${live ? `<script>
  const stream = new EventSource('/events');
  stream.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    document.getElementById('scene-frame').innerHTML = frame.svg;
  };
  </script>` : ""}</body></html>`;
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export function createService() {
  let snapshots;
  let latestScene = null;
  let latestSvg = null;
  let document = "<!doctype html><title>FGPM runtime starting</title>";
  let server = null;
  let runtimeUrl = null;
  let snapshotPath = null;
  const eventClients = new Set();
  const windowCapability = Object.freeze({
    scene: () => latestScene,
    svg: () => latestSvg,
    url: () => runtimeUrl,
  });
  return {
    async activate(context) {
      snapshots = context.require("runtime.scene-snapshot");
      const output = context.grant("fgpm.host.renderer-output/1");
      const interaction = context.grant("fgpm.host.runtime-interaction/1");
      snapshotPath = output.snapshotPath;
      latestScene = snapshots.current();
      latestSvg = renderSvg(latestScene);
      document = html(latestScene, latestSvg);
      if (snapshotPath) {
        await mkdir(path.dirname(snapshotPath), { recursive: true });
        await writeFile(snapshotPath, `${latestSvg}\n`, "utf8");
      }
      if (interaction.interactive) {
        server = http.createServer((request, responseValue) => {
          if (request.url === "/events") {
            responseValue.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive",
            });
            eventClients.add(responseValue);
            responseValue.write(`data: ${JSON.stringify({ svg: latestSvg })}\n\n`);
            request.once("close", () => eventClients.delete(responseValue));
            return;
          }
          if (request.url !== "/") {
            responseValue.writeHead(404).end("Not found");
            return;
          }
          responseValue.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          responseValue.end(document);
        });
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        runtimeUrl = `http://127.0.0.1:${address.port}/`;
        console.log(`Runtime: ${runtimeUrl}`);
        console.log("Press Ctrl+C to stop the live runtime.");
        if (interaction.openBrowser) openBrowser(runtimeUrl);
      }
      return {
        protocol: "fgpm.runtime-service-response/1",
        capabilities: { "runtime.renderer.window": windowCapability },
      };
    },
    async tick() {
      latestScene = snapshots.current();
      latestSvg = renderSvg(latestScene);
      document = html(latestScene, latestSvg);
      const event = `data: ${JSON.stringify({ svg: latestSvg })}\n\n`;
      for (const client of eventClients) client.write(event);
      if (snapshotPath) {
        await mkdir(path.dirname(snapshotPath), { recursive: true });
        await writeFile(snapshotPath, `${latestSvg}\n`, "utf8");
      }
    },
    async deactivate() {
      for (const client of eventClients) client.end();
      eventClients.clear();
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
      runtimeUrl = null;
      snapshots = null;
      snapshotPath = null;
    },
  };
}

async function directMain() {
  const [sceneArgument, ...argumentsList] = process.argv.slice(2);
  if (!sceneArgument) {
    console.error("Usage: node runtime.mjs <scene.json> [--snapshot <output.svg>]");
    process.exitCode = 2;
    return;
  }
  const scene = JSON.parse(await readFile(path.resolve(sceneArgument), "utf8"));
  if (scene.schema !== "fgpm.render-scene/1") {
    console.error(`Unsupported scene schema: ${scene.schema}`);
    process.exitCode = 2;
    return;
  }
  const svg = renderSvg(scene);
  const snapshotIndex = argumentsList.indexOf("--snapshot");
  if (snapshotIndex !== -1) {
    const snapshotPath = path.resolve(argumentsList[snapshotIndex + 1]);
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${svg}\n`, "utf8");
    console.log(`Snapshot: ${snapshotPath}`);
  } else {
    const document = html(scene, svg, false);
    const server = http.createServer((request, responseValue) => {
      if (request.url !== "/") {
        responseValue.writeHead(404).end("Not found");
        return;
      }
      responseValue.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      responseValue.end(document);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}/`;
      console.log(`Runtime: ${url}`);
      console.log("Press Ctrl+C to stop the disposable runtime.");
      openBrowser(url);
    });
  }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) await directMain();
