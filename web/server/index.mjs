// StablePilot web backend.
//
// Deliberately tiny and dependency-free: Node 24's built-in HTTP server, and
// `dist/plugin.mjs` driven over MCP stdio. There is no framework, no database
// and no external service, so the app runs with `node web/server/index.mjs`.
//
// This server is NOT part of the PayBox plugin. The artifact uploaded to the
// PayBox developer portal is still `dist/plugin.mjs` on its own; nothing here
// is bundled into it and nothing here changes its behaviour.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CALL_TIMEOUT_MS,
  PluginCallError,
  callTool,
  fingerprint,
  listTools,
} from "./mcp-client.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(here, "..", "public");

/** The built plugin. Override with PLUGIN_ARTIFACT when running from elsewhere. */
const artifact = process.env.PLUGIN_ARTIFACT
  ? resolve(process.env.PLUGIN_ARTIFACT)
  : resolve(here, "..", "..", "dist", "plugin.mjs");

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";

const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function log(...parts) {
  process.stdout.write(`[stablepilot] ${parts.join(" ")}\n`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  // Vercel's Node runtime may hand the function an already-parsed body. Local
  // `node web/server/index.mjs` uses the raw stream. Support both so the same
  // handler works in a long-lived process and in a serverless function.
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    return req.body ?? {};
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Guards against `../` escaping the public directory. */
function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  // Check the request as written: normalising first would collapse `..` at the
  // root and quietly turn a traversal attempt into a legitimate path.
  if (decoded.split(/[\\/]/).includes("..")) return null;
  const candidate = resolve(publicDir, "." + normalize(decoded));
  if (candidate !== publicDir && !candidate.startsWith(publicDir + sep)) return null;
  return candidate;
}

async function serveStatic(res, urlPath) {
  let target = safePublicPath(urlPath);
  if (!target) {
    sendJson(res, 400, { error: "Bad path" });
    return;
  }

  let info = await stat(target).catch(() => null);
  // Unknown paths fall through to the single-page app shell.
  if (!info || info.isDirectory()) {
    target = join(publicDir, "index.html");
    info = await stat(target).catch(() => null);
  }
  if (!info) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const body = await readFile(target);
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleHealth(res) {
  const [info, tools] = await Promise.all([
    fingerprint(artifact),
    listTools(artifact),
  ]);
  sendJson(res, 200, {
    ok: true,
    artifact: info,
    protocolVersion: tools.protocolVersion,
    tools: tools.tools.map((tool) => tool.name),
  });
}

async function handleTools(res) {
  const { tools, durationMs } = await listTools(artifact);
  sendJson(res, 200, {
    ok: true,
    durationMs: Math.round(durationMs),
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  });
}

async function handleToolCall(res, toolName, body) {
  const args = body && typeof body.arguments === "object" && body.arguments !== null ? body.arguments : {};

  // Only forward tools the plugin actually advertises, so the endpoint cannot be
  // used to probe for methods the plugin does not expose.
  const { tools } = await listTools(artifact);
  const known = new Set(tools.map((tool) => tool.name));
  if (!known.has(toolName)) {
    sendJson(res, 404, { ok: false, error: `Unknown tool: ${toolName}`, code: "unknown_tool" });
    return;
  }

  const { result, durationMs } = await callTool(artifact, toolName, args);
  const isError = result?.isError === true;
  const status = result?.structuredContent?.status ?? (isError ? "error" : "ok");
  log(`tools/call ${toolName} -> ${status} in ${Math.round(durationMs)}ms`);

  sendJson(res, 200, {
    ok: true,
    tool: toolName,
    durationMs: Math.round(durationMs),
    result,
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function handler(req, res) {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  try {
    if (path === "/api/health") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET" });
      return await handleHealth(res);
    }

    if (path === "/api/tools") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET" });
      return await handleTools(res);
    }

    const callMatch = path.match(/^\/api\/tools\/([A-Za-z0-9_]+)$/);
    if (callMatch) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
      const body = await readBody(req);
      return await handleToolCall(res, callMatch[1], body);
    }

    if (path.startsWith("/api/")) {
      return sendJson(res, 404, { error: "Unknown endpoint" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Use GET" });
    }
    return await serveStatic(res, path);
  } catch (error) {
    if (error instanceof PluginCallError) {
      log(`error ${error.code}: ${error.message}`);
      return sendJson(res, 502, {
        ok: false,
        code: error.code,
        error: error.message,
        stderr: error.stderr?.slice(0, 2000) ?? "",
        durationMs: Math.round(error.durationMs ?? 0),
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`error ${message}`);
    return sendJson(res, 500, { ok: false, code: "server_error", error: message });
  }
}

const server = createServer(handler);

// `api/[...path].mjs` imports this module on Vercel and must not open a port.
// Only start the long-lived server when this file is run directly.
const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  // Refuse to start with a missing or unbuilt artifact rather than failing on
  // the first tool call, and say exactly what to run.
  const artifactInfo = await stat(artifact).catch(() => null);
  if (!artifactInfo) {
    process.stderr.write(
      `StablePilot web: the plugin bundle was not found at\n  ${artifact}\n` +
        `Build it first:\n  pnpm run build\n`,
    );
    process.exit(1);
  }

  server.listen(port, host, () => {
    const bound = server.address().port;
    log(`listening on http://${host}:${bound}`);
    log(`plugin artifact ${artifact} (${artifactInfo.size} bytes)`);
    log(`per-call timeout ${CALL_TIMEOUT_MS}ms`);
  });
}
