// Does the built artifact really stand alone?
//
// The guide requires "all package dependencies must be bundled" and lists
// `startup_failed` for the case where they are not. Locally that is easy to get
// wrong, because a lazy `require()` inside the bundle would resolve happily
// against this project's node_modules and fail in the hosted sandbox, where
// only `plugin.mjs` exists.
//
// This copies the artifact alone into a fresh temporary directory, with no
// node_modules anywhere above it, and drives tools/list plus a proposal call
// over stdio. Throwaway probe; the assertion lives in tests/protocol.test.ts.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const artifact = resolve(process.cwd(), "dist", "plugin.mjs");
const sandbox = await mkdtemp(join(tmpdir(), "stablepilot-isolated-"));
const isolated = join(sandbox, "plugin.mjs");
await copyFile(artifact, isolated);

const protocol = JSON.parse(await readFile(resolve(process.cwd(), "starter-version.json"), "utf8")).protocolVersion;

async function rpc(method, params) {
  const home = await mkdtemp(join(tmpdir(), "stablepilot-isolated-home-"));
  const child = spawn(process.execPath, [isolated], {
    cwd: dirname(isolated),
    env: { HOME: home, NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocol,
            "io.modelcontextprotocol/clientInfo": { name: "isolation-probe", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`,
    );
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (!("id" in message)) continue;
      return { message, stderr };
    }
    return { message: null, stderr };
  } finally {
    lines.close();
    child.kill();
    // Wait for the child to exit before cleaning up: Windows keeps the artifact
    // locked briefly, and an unlucky rm() fails with EBUSY.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((settle) => child.once("close", () => settle()));
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const list = await rpc("tools/list", {});
console.log("tools/list ->", list.message?.result ? "ok" : "FAILED");
console.log("  tool count:", list.message?.result?.tools?.length);
if (list.message?.error) console.log("  error:", JSON.stringify(list.message.error));

const call = await rpc("tools/call", {
  name: "propose_usdc_payment",
  arguments: {
    chain: "base",
    recipient: "0x000000000000000000000000000000000000dEaD",
    amountUsdc: "5",
    availableUsdc: "100",
    spendingAllocationUsdc: "10",
    emergencyReserveUsdc: "20",
    maxPaymentUsdc: "5",
  },
});
console.log("tools/call propose_usdc_payment ->", call.message?.result ? (call.message.result.isError ? "isError" : "ok") : "FAILED");
console.log("  has proposal:", Boolean(call.message?.result?.structuredContent?.["io.paybox/transactionProposal"]));
if (call.message?.error) console.log("  error:", JSON.stringify(call.message.error));
if (call.stderr.trim()) console.log("  stderr:", call.stderr.trim().slice(0, 600));

await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
