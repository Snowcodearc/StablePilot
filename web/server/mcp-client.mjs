// MCP stdio client for the StablePilot PayBox plugin.
//
// This is the whole of the web app's plugin integration: it spawns the shipped
// `dist/plugin.mjs` as a child process and speaks newline-delimited JSON-RPC to
// it over stdin/stdout, which is exactly the transport PayBox itself uses.
//
// A fresh process is spawned per call, deliberately. The PayBox plugin guide
// says each operation may run in a fresh process and that plugins must not rely
// on memory surviving between calls, so mirroring that here keeps the web app
// honest: nothing is cached in the plugin, and no state can leak between two
// requests in the browser. The cost is roughly 300-450ms per call, which the UI
// covers with a loading state.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

/** The protocol revision the plugin advertises, matching paybox-plugin.json. */
export const PROTOCOL_VERSION = "2026-07-28";

/**
 * Per-operation ceiling. The hosted budget is ten seconds, so the adapter
 * refuses to wait longer than that and reports a timeout instead of hanging.
 */
export const CALL_TIMEOUT_MS = 10_000;

export class PluginCallError extends Error {
  constructor(message, { stderr = "", durationMs = 0, code = "plugin_error" } = {}) {
    super(message);
    this.name = "PluginCallError";
    this.code = code;
    this.stderr = stderr;
    this.durationMs = durationMs;
  }
}

/**
 * Sends one JSON-RPC request to a freshly spawned plugin process and resolves
 * with the matching response.
 *
 * @param {string} artifact Absolute path to the built plugin bundle.
 * @param {string} method   JSON-RPC method, e.g. "tools/list".
 * @param {object} params   Request params, without `_meta`.
 * @param {{timeoutMs?: number, id?: number}} [options]
 */
export async function callPlugin(artifact, method, params = {}, options = {}) {
  const { timeoutMs = CALL_TIMEOUT_MS, id = 1 } = options;
  const startedAt = process.hrtime.bigint();

  const child = spawn(process.execPath, [artifact], {
    cwd: dirname(artifact),
    stdio: ["pipe", "pipe", "pipe"],
    env: { NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "" },
  });

  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const request = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "stablepilot-web", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };

  try {
    return await new Promise((resolve, reject) => {
      const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

      const timer = setTimeout(() => {
        reject(
          new PluginCallError(`${method} did not respond within ${timeoutMs}ms`, {
            stderr,
            durationMs: elapsed(),
            code: "timeout",
          }),
        );
      }, timeoutMs);

      const settle = (fn, value) => {
        clearTimeout(timer);
        fn(value);
      };

      lines.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          // stdout is reserved for MCP frames; anything else is a protocol
          // violation worth surfacing rather than skipping quietly.
          settle(
            reject,
            new PluginCallError(`Non-JSON output on stdout: ${trimmed.slice(0, 200)}`, {
              stderr,
              durationMs: elapsed(),
              code: "protocol_violation",
            }),
          );
          return;
        }

        if (!("id" in message) || message.id !== id) return;
        settle(resolve, { message, durationMs: elapsed(), stderr });
      });

      child.once("error", (error) => {
        settle(
          reject,
          new PluginCallError(`Could not start the plugin: ${error.message}`, {
            stderr,
            durationMs: elapsed(),
            code: "spawn_failed",
          }),
        );
      });

      child.once("close", (code) => {
        settle(
          reject,
          new PluginCallError(`The plugin exited before responding (code ${code ?? "null"})`, {
            stderr,
            durationMs: elapsed(),
            code: "early_exit",
          }),
        );
      });

      child.stdin.on("error", () => {
        // A refused stdin write means the process is already gone; the close
        // handler above reports that with a better message.
      });

      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/** Discovers the tools the plugin advertises, via the real `tools/list`. */
export async function listTools(artifact, options = {}) {
  const { message, durationMs } = await callPlugin(artifact, "tools/list", {}, options);
  if (message.error) {
    throw new PluginCallError(`tools/list failed: ${message.error.message}`, { durationMs });
  }
  return { tools: message.result?.tools ?? [], durationMs, protocolVersion: PROTOCOL_VERSION };
}

/**
 * Executes one tool through the real `tools/call`.
 *
 * The plugin's own result is returned untouched, including `isError` and the
 * text content, so the interface never has to reinterpret a plugin decision.
 */
export async function callTool(artifact, name, args, options = {}) {
  const { message, durationMs, stderr } = await callPlugin(
    artifact,
    "tools/call",
    { name, arguments: args },
    options,
  );

  if (message.error) {
    throw new PluginCallError(`tools/call ${name} failed: ${message.error.message}`, {
      stderr,
      durationMs,
    });
  }

  return { result: message.result, durationMs, stderr };
}

/** Size and digest of the artifact, so the UI can show what it is talking to. */
export async function fingerprint(artifact) {
  const [bytes, sha256] = await Promise.all([
    stat(artifact).then((s) => s.size),
    readFile(artifact).then((buffer) => createHash("sha256").update(buffer).digest("hex")),
  ]);
  return { path: artifact, bytes, sha256 };
}
