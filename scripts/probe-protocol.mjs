// Local mirror of PayBox's conformance flow, for platforms the official
// scripts/report.mjs refuses (it requires darwin or linux).
//
// This is NOT a substitute for `pnpm test`; it runs the same JSON-RPC exchange
// the official check runs, against the real built bundle, so a Windows or macOS
// developer can verify protocol compatibility before switching to WSL2.
//
// Usage: node scripts/probe-protocol.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const PROTOCOL_VERSION = "2026-07-28";
const root = process.cwd();
const artifact = resolve(root, "dist/plugin.mjs");

async function call(operation, id = 2) {
  const home = await mkdtemp(resolve(tmpdir(), "stablepilot-probe-"));
  const child = spawn(process.execPath, [artifact], {
    cwd: dirname(artifact),
    env: { HOME: home, NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: operation.method,
      params: {
        ...operation.params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "stablepilot-probe", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    })}\n`);

    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("probe timed out")), 10_000);
      lines.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { rejectPromise(new Error(`non-JSON stdout: ${line.slice(0, 200)}`)); return; }
        if (!("id" in message) || message.id !== id) return;
        clearTimeout(timer);
        resolvePromise(message);
      });
      child.once("close", (code) => { clearTimeout(timer); rejectPromise(new Error(`plugin exited early (code ${code}); stderr: ${stderr.slice(0, 400)}`)); });
    });
  } finally {
    lines.close();
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
}

const list = await call({ method: "tools/list", params: {} });
console.log("tools/list resultType:", list.result?.resultType);
console.log("tools:", list.result?.tools?.map((t) => t.name).join(", "));

const sample = JSON.parse(await readFile(resolve(root, "paybox-plugin.json"), "utf8"));
const called = await call({ method: "tools/call", params: { name: sample.tool, arguments: sample.arguments } });
console.log("tools/call resultType:", called.result?.resultType);
console.log("isError:", called.result?.isError);
console.log("content:", called.result?.content?.[0]?.text?.slice(0, 200));
console.log("structuredContent:", JSON.stringify(called.result?.structuredContent).slice(0, 300));
