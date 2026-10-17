// Protocol and packaging tests: the built bundle really speaks the PayBox MCP
// dialect, advertises the four tools, and returns schema-valid results.
//
// This is a faithful local mirror of the official `scripts/conformance.mjs`
// exchange (newline-delimited JSON-RPC on stdout, a fresh process per
// operation, the 2026-07-28 `_meta` opening, `resultType: "complete"`, and AJV
// validation of the advertised JSON Schemas). It exists because the official
// runner refuses to execute anywhere except macOS and Linux
// (`environment_invalid` on win32), and `pnpm test` must still be runnable and
// honest on a Windows machine without WSL2. It does not replace `pnpm test`.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
// Named import: ajv ships CommonJS, and the starter's tsconfig has neither
// esModuleInterop nor allowSyntheticDefaultImports, so the default export is
// not constructable at the type level. ajv sets `module.exports.Ajv2020`
// explicitly, so the named import resolves at runtime too.
import { Ajv2020 } from "ajv/dist/2020.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ARTIFACT = path.join(ROOT, "dist", "plugin.mjs");
const PROTOCOL_VERSION = "2026-07-28";
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_TOOL_NAME_BYTES = 128;

const REQUIRED_TOOLS = [
  "check_payment_policy",
  "get_allocation_report",
  "plan_stablecoin_allocation",
  "propose_usdc_payment",
];

/**
 * Material that must never reach a published bundle. `seed` is deliberately
 * absent: it is too common a substring to assert on meaningfully.
 */
const FORBIDDEN_IN_BUNDLE = ["-----BEGIN", "privateKey", "PRIVATE_KEY", "mnemonic", "seedPhrase", "wallet_id"];

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** Bundle the plugin exactly as `pnpm build` does, without shelling out. */
async function bundle(outfile: string): Promise<void> {
  await build({
    entryPoints: [path.join(ROOT, "src", "plugin.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    minify: true,
    outfile,
    absWorkingDir: ROOT,
    logLevel: "silent",
  });
}

/**
 * Run one JSON-RPC operation against a fresh instance of the built artifact.
 *
 * `artifactPath` exists so the suite can also drive a copy of the bundle that
 * sits in a directory with no `node_modules` anywhere above it, which is what
 * the hosted sandbox looks like.
 */
async function rpc(
  method: string,
  params: Record<string, unknown>,
  artifactPath: string = ARTIFACT,
): Promise<JsonRpcResponse> {
  const home = await mkdtemp(path.join(tmpdir(), "stablepilot-protocol-"));
  const child = spawn(process.execPath, [artifactPath], {
    cwd: path.dirname(artifactPath),
    env: { HOME: home, NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
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
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "stablepilot-protocol-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`,
    );

    for await (const line of lines) {
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        throw new Error(`plugin stdout contained non-JSON output: ${line.slice(0, 200)}`);
      }
      if (!("id" in message)) continue;
      if (message.id !== 2) throw new Error("plugin response id did not match the request id");
      return message;
    }
    throw new Error(`plugin exited before returning a response. stderr: ${stderr.slice(0, 400)}`);
  } finally {
    lines.close();
    child.kill();
    await ended(child);
    await rm(home, { recursive: true, force: true });
  }
}

/** Wait for a child to exit, so temporary files are not removed while locked. */
function ended(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((settle) => {
    child.once("close", () => settle());
  });
}

/** Call a tool and assert the transport-level result is a success. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const message = await rpc("tools/call", { name, arguments: args });
  assert.equal(message.error, undefined, `tools/call ${name} failed: ${message.error?.message ?? "no message"}`);
  const result = message.result;
  assert.ok(result, `tools/call ${name} returned no result`);
  assert.equal(result.resultType, "complete", `tools/call ${name} did not report resultType complete`);
  return result;
}

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, logger: false });
  const validate = ajv.compile(schema as object);
  // Mirrors the official schema.mjs guard: async schemas are unsupported.
  if ((validate as { $async?: boolean }).$async) throw new Error("asynchronous schemas are unsupported");
  return validate;
}

before(async () => {
  await bundle(ARTIFACT);
});

// --- Packaging --------------------------------------------------------------

test("the build emits a dist/plugin.mjs under the 10 MiB ceiling", async () => {
  const info = await stat(ARTIFACT);
  assert.ok(info.size > 0, "artifact is empty");
  assert.ok(info.size < MAX_ARTIFACT_BYTES, `artifact is ${info.size} bytes, at or above the 10 MiB ceiling`);
});

test("the artifact is valid UTF-8", async () => {
  const bytes = await readFile(ARTIFACT);
  const text = bytes.toString("utf8");
  assert.equal(Buffer.from(text, "utf8").equals(bytes), true, "artifact is not valid UTF-8");
});

test("two builds of the same sources produce identical bytes", async () => {
  const first = path.join(tmpdir(), `stablepilot-first-${process.pid}.mjs`);
  const second = path.join(tmpdir(), `stablepilot-second-${process.pid}.mjs`);
  try {
    await bundle(first);
    await bundle(second);
    const a = await readFile(first);
    const b = await readFile(second);
    assert.equal(a.length, b.length, "builds differ in length");
    assert.equal(Buffer.compare(a, b), 0, "builds are not byte-identical");
  } finally {
    await rm(first, { force: true });
    await rm(second, { force: true });
  }
});

test("the artifact carries no key material", async () => {
  const text = await readFile(ARTIFACT, "utf8");
  for (const forbidden of FORBIDDEN_IN_BUNDLE) {
    assert.equal(text.includes(forbidden), false, `artifact contains forbidden substring "${forbidden}"`);
  }
});

test("no environment file is present to be uploaded by mistake", async () => {
  for (const name of [".env", ".env.local", ".env.production"]) {
    await assert.rejects(stat(path.join(ROOT, name)), `${name} must not exist in the project`);
  }
});

// --- Tool catalog -----------------------------------------------------------

test("tools/list declares the four StablePilot tools with valid schemas", async () => {
  const message = await rpc("tools/list", {});
  assert.equal(message.error, undefined);
  const result = message.result;
  assert.ok(result, "tools/list returned no result");
  assert.equal(result.resultType, "complete", "tools/list must report resultType complete");

  const tools = result.tools;
  assert.ok(Array.isArray(tools), "tools/list must contain a tools array");
  assert.deepEqual(
    (tools as Array<{ name: string }>).map((tool) => tool.name).sort(),
    REQUIRED_TOOLS,
  );

  const seen = new Set<string>();
  for (const raw of tools as Array<Record<string, unknown>>) {
    const name = raw.name;
    assert.equal(typeof name, "string", "tool name must be a string");
    const toolName = name as string;
    assert.equal(seen.has(toolName), false, `duplicate tool name ${toolName}`);
    seen.add(toolName);
    assert.ok(Buffer.byteLength(toolName) <= MAX_TOOL_NAME_BYTES, `${toolName} name exceeds ${MAX_TOOL_NAME_BYTES} bytes`);

    assert.equal(typeof raw.title, "string", `${toolName} has no title`);
    assert.equal(typeof raw.description, "string", `${toolName} has no description`);
    assert.ok((raw.description as string).length > 60, `${toolName} description is too short for an agent to choose on`);
    assert.equal(typeof raw.annotations, "object", `${toolName} declares no annotations`);

    assert.equal(JSON.stringify(raw).includes("x-mcp-header"), false, `${toolName} uses unsupported x-mcp-header`);

    const inputSchema = raw.inputSchema;
    const outputSchema = raw.outputSchema;
    assert.ok(inputSchema, `${toolName} declares no input schema`);
    assert.ok(outputSchema, `${toolName} declares no output schema`);

    const schemaBytes =
      Buffer.byteLength(JSON.stringify(inputSchema)) + Buffer.byteLength(JSON.stringify(outputSchema));
    assert.ok(schemaBytes <= MAX_TOOL_SCHEMA_BYTES, `${toolName} schemas exceed ${MAX_TOOL_SCHEMA_BYTES} bytes`);

    assert.doesNotThrow(() => compile(inputSchema), `${toolName} input schema is not valid JSON Schema 2020-12`);
    assert.doesNotThrow(() => compile(outputSchema), `${toolName} output schema is not valid JSON Schema 2020-12`);
  }
});

// --- The configured conformance sample --------------------------------------

test("the paybox-plugin.json sample executes and matches its declared output schema", async () => {
  const config = JSON.parse(await readFile(path.join(ROOT, "paybox-plugin.json"), "utf8")) as {
    tool: string;
    arguments: Record<string, unknown>;
  };
  assert.equal(typeof config.tool, "string");
  assert.equal(typeof config.arguments, "object");

  const list = await rpc("tools/list", {});
  const tools = (list.result?.tools ?? []) as Array<Record<string, unknown>>;
  const selected = tools.find((tool) => tool.name === config.tool);
  assert.ok(selected, `sample tool ${config.tool} is not advertised by tools/list`);

  const input = compile(selected.inputSchema);
  assert.equal(input(config.arguments), true, `sample arguments do not match ${config.tool}: ${JSON.stringify(input.errors)}`);

  const result = await callTool(config.tool, config.arguments);
  assert.notEqual(result.isError, true, "the sample call must not report an error");

  const output = compile(selected.outputSchema);
  assert.equal(
    output(result.structuredContent),
    true,
    `sample structuredContent does not match ${config.tool}: ${JSON.stringify(output.errors)}`,
  );

  const structured = result.structuredContent as {
    status: string;
    plan: { unallocatedUsdc: string; totalAllocatedUsdc: string; percentages: Record<string, string> };
  };
  assert.equal(structured.status, "planned");
  assert.equal(structured.plan.unallocatedUsdc, "0");
  assert.equal(structured.plan.totalAllocatedUsdc, "100");
  assert.equal(structured.plan.percentages.spending, "10.00");
});

// --- Every tool, over the wire ---------------------------------------------

const CALLS: ReadonlyArray<{ tool: string; args: Record<string, unknown> }> = [
  {
    tool: "plan_stablecoin_allocation",
    args: { totalUsdc: "100", spendingUsdc: "10", savingsUsdc: "70", emergencyReserveUsdc: "20", savingsGoalUsdc: "50" },
  },
  {
    tool: "check_payment_policy",
    args: {
      availableUsdc: "100",
      spendingAllocationUsdc: "10",
      emergencyReserveUsdc: "20",
      paymentAmountUsdc: "5",
      maxPaymentUsdc: "5",
      recipient: "0x000000000000000000000000000000000000dEaD",
    },
  },
  {
    tool: "propose_usdc_payment",
    args: {
      chain: "base",
      recipient: "0x000000000000000000000000000000000000dEaD",
      amountUsdc: "5",
      availableUsdc: "100",
      spendingAllocationUsdc: "10",
      emergencyReserveUsdc: "20",
      maxPaymentUsdc: "5",
    },
  },
  {
    tool: "get_allocation_report",
    args: { totalUsdc: "100", spendingUsdc: "10", savingsUsdc: "70", emergencyReserveUsdc: "20", proposedPaymentUsdc: "5" },
  },
];

test("every tool returns schema-valid structured content over real stdio", async () => {
  const list = await rpc("tools/list", {});
  const tools = (list.result?.tools ?? []) as Array<Record<string, unknown>>;

  for (const { tool: name, args } of CALLS) {
    const selected = tools.find((tool) => tool.name === name);
    assert.ok(selected, `${name} is not advertised`);
    const output = compile(selected.outputSchema);

    const result = await callTool(name, args);
    assert.notEqual(result.isError, true, `${name} reported an error`);
    assert.equal(
      output(result.structuredContent),
      true,
      `${name} structuredContent does not match its schema: ${JSON.stringify(output.errors)}`,
    );
    assert.ok(Array.isArray(result.content), `${name} returned no content array`);
  }
});

test("the proposal tool returns the PayBox envelope and nothing else", async () => {
  const result = await callTool("propose_usdc_payment", CALLS[2]?.args ?? {});
  const structured = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(Object.keys(structured), ["io.paybox/transactionProposal"]);

  const proposal = structured["io.paybox/transactionProposal"] as {
    version: string;
    kind: string;
    chain: string;
    expiresAt: string;
    transaction: { to: string; value: string; data: string };
  };
  assert.equal(proposal.version, "1");
  assert.equal(proposal.kind, "evm");
  assert.equal(proposal.chain, "eip155:8453");
  assert.equal(proposal.transaction.value, "0");
  assert.equal(proposal.transaction.to, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.match(proposal.transaction.data, /^0xa9059cbb[0-9a-f]{128}$/);
  assert.match(proposal.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const expires = Date.parse(proposal.expiresAt);
  assert.ok(expires > Date.now(), "the proposal must not already be expired");
  assert.ok(expires <= Date.now() + 300_000, "the proposal must expire within five minutes");
});

test("a blocked payment returns an error and never a transaction proposal", async () => {
  const result = await callTool("propose_usdc_payment", {
    chain: "base",
    recipient: "0x000000000000000000000000000000000000dEaD",
    amountUsdc: "15",
    availableUsdc: "100",
    spendingAllocationUsdc: "10",
    emergencyReserveUsdc: "20",
    maxPaymentUsdc: "5",
  });
  // The tool reports the refusal as an error result, with no structuredContent
  // and therefore no proposal.
  const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
  assert.match(text, /blocked by your policy rules/);
});

test("an unknown tool is refused without breaking the server", async () => {
  const refused = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
  assert.ok(
    refused.error !== undefined || refused.result?.isError === true,
    "an unknown tool must not be reported as a success",
  );

  const after = await callTool("plan_stablecoin_allocation", CALLS[0]?.args ?? {});
  assert.equal((after.structuredContent as { status: string }).status, "planned");
});

test("unknown argument fields are rejected without breaking the server", async () => {
  const refused = await rpc("tools/call", {
    name: "plan_stablecoin_allocation",
    arguments: { totalUsdc: "100", spendingUsdc: "10", savingsUsdc: "70", emergencyReserveUsdc: "20", nonsense: true },
  });
  assert.ok(
    refused.error !== undefined || refused.result?.isError === true,
    "an unknown argument field must not be accepted",
  );

  const after = await callTool("plan_stablecoin_allocation", CALLS[0]?.args ?? {});
  assert.equal((after.structuredContent as { status: string }).status, "planned");
});

// --- The `explain` preference, at the tool boundary -------------------------

test("the plan tool returns a full explanation by default", async () => {
  const result = await callTool("plan_stablecoin_allocation", {
    totalUsdc: "100",
    spendingUsdc: "10",
    savingsUsdc: "70",
    emergencyReserveUsdc: "20",
  });
  const structured = result.structuredContent as { status: string; explanation?: string };
  assert.equal(structured.status, "planned");
  assert.equal(typeof structured.explanation, "string");
  assert.match((result.content as Array<{ text: string }>)[0]?.text ?? "", /Allocation plan for 100 USDC/);
});

test("the plan tool honours explain: false with a one-line summary and no prose", async () => {
  const result = await callTool("plan_stablecoin_allocation", {
    totalUsdc: "100",
    spendingUsdc: "10",
    savingsUsdc: "70",
    emergencyReserveUsdc: "20",
    explain: false,
  });
  const structured = result.structuredContent as { status: string; explanation?: string; plan?: unknown };
  assert.equal(structured.status, "planned");
  assert.equal("explanation" in structured, false, "explain:false must not include the prose explanation");
  assert.ok(structured.plan, "the structured plan is still returned");

  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  assert.match(text, /^Planned 100 USDC:/);
  assert.equal(text.split("\n").length, 1);
});

test("an unusable plan is reported as an error with a reason", async () => {
  const message = await rpc("tools/call", {
    name: "plan_stablecoin_allocation",
    arguments: { totalUsdc: "100", spendingUsdc: "90", savingsUsdc: "90", emergencyReserveUsdc: "20" },
  });
  assert.equal(message.error, undefined, "a domain-level rejection is a tool error, not a transport error");
  const result = message.result;
  assert.ok(result);
  assert.equal(result.isError, true);
  assert.match(((result.content as Array<{ text: string }>)[0]?.text ?? ""), /200 USDC/);
});

// ---------------------------------------------------------------------------
// Official requirements: the 10-second budget, standalone bundling, no network
// ---------------------------------------------------------------------------

const DOCUMENTED_OPERATION_BUDGET_MS = 10_000;

/**
 * The guide's codegen-template requires. ajv embeds these strings into the
 * validator source it generates for a schema that uses `const`/`equal`,
 * `maxLength`, `format`, or `$async`. They are inert for StablePilot's schemas,
 * which the isolation test below demonstrates, but any *other* unbundled
 * require would fail in the hosted sandbox where only `plugin.mjs` exists.
 */
const AJV_CODEGEN_TEMPLATES = new Set([
  "ajv/dist/runtime/equal",
  "ajv/dist/runtime/ucs2length",
  "ajv/dist/runtime/uri",
  "ajv/dist/runtime/validation_error",
  "ajv-formats/dist/formats",
]);

/** Network-capable APIs that must not be reachable from the artifact. */
const NETWORK_APIS = [
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "axios",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:dgram",
];

/**
 * Wording the guide forbids, or that would overstate what this plugin does.
 *
 * "Simulation success does not establish economic safety or guarantee later
 * execution." "A proposal is not a receipt." "The wallet still needs native
 * currency for network fees." "Do not describe plugin text as a PayBox-verified
 * token or swap preview." "PayBox does not ... choose slippage."
 */
const FORBIDDEN_CLAIMS = [
  "stabilpilot simulated",
  "we simulated",
  "simulation passed",
  "simulation succeeded",
  "simulation confirmed",
  "paybox-verified",
  "verified preview",
  "guaranteed",
  "guarantees",
  "fees included",
  "gas included",
  "fee estimate",
  "gas estimate",
  "estimated fee",
  "estimated gas",
  "maxfeepergas",
  "gaslimit",
  "slippage",
];

function specifiers(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

test("every tool operation completes inside the documented 10-second budget", async () => {
  // "Complete each operation within 10 seconds." Measured the way the official
  // runner measures it: the whole operation, including process start.
  const measurements: Array<{ tool: string; ms: number }> = [];

  for (const { tool: name, args } of CALLS) {
    const started = performance.now();
    await callTool(name, args);
    measurements.push({ tool: name, ms: Math.round(performance.now() - started) });
  }

  process.stderr.write(`operation timings: ${measurements.map((m) => `${m.tool}=${m.ms}ms`).join(", ")}\n`);

  for (const { tool: name, ms } of measurements) {
    assert.ok(ms < DOCUMENTED_OPERATION_BUDGET_MS, `${name} took ${ms}ms, at or over the documented 10-second limit`);
    // A deliberate local margin: the hosted budget is 10s, so anything close to
    // half of that on an idle dev machine means the tool is doing real work.
    assert.ok(ms < DOCUMENTED_OPERATION_BUDGET_MS / 2, `${name} took ${ms}ms, outside this suite's local margin`);
  }
});

test("tool discovery completes inside the documented 10-second budget", async () => {
  // Discovery runs in the hosted preflight and can be retried, so it has the
  // same 10-second budget as any other operation and must stay side-effect free.
  const started = performance.now();
  const message = await rpc("tools/list", {});
  const ms = Math.round(performance.now() - started);

  process.stderr.write(`discovery timing: tools/list=${ms}ms\n`);
  assert.equal(message.error, undefined);
  assert.ok(ms < DOCUMENTED_OPERATION_BUDGET_MS, `tool discovery took ${ms}ms`);
});

test("the artifact runs with no dependencies present", async () => {
  // "all package dependencies must be bundled" (startup_failed). Locally a lazy
  // require() would resolve against this project's node_modules and hide the
  // problem, so the bundle is copied somewhere with no node_modules above it.
  const sandbox = await mkdtemp(path.join(tmpdir(), "stablepilot-isolated-"));
  const isolated = path.join(sandbox, "plugin.mjs");

  try {
    await copyFile(ARTIFACT, isolated);

    const list = await rpc("tools/list", {}, isolated);
    assert.equal(list.error, undefined, "tools/list must work with no dependencies installed");
    assert.equal(((list.result?.tools ?? []) as unknown[]).length, 4);

    const call = await rpc("tools/call", { name: "propose_usdc_payment", arguments: CALLS[2]?.args ?? {} }, isolated);
    assert.equal(call.error, undefined, "a proposal call must work with no dependencies installed");
    const structured = call.result?.structuredContent as Record<string, unknown> | undefined;
    assert.ok(structured?.["io.paybox/transactionProposal"], "the proposal must still be built");
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the artifact reaches no network", async () => {
  const text = await readFile(ARTIFACT, "utf8");

  for (const api of NETWORK_APIS) {
    assert.equal(text.includes(api), false, `artifact contains the network API "${api}"`);
  }

  // Static imports must all be Node builtins: everything else is bundled.
  for (const specifier of specifiers(text, /from\s*["']([^"']+)["']/g)) {
    assert.match(specifier, /^node:/, `unbundled static import "${specifier}"`);
  }

  // Lazy requires must be ajv's codegen templates and nothing else.
  for (const specifier of specifiers(text, /require\(\s*["']([^"']+)["']\s*\)/g)) {
    assert.equal(
      AJV_CODEGEN_TEMPLATES.has(specifier),
      true,
      `unexpected lazy require("${specifier}"); it would not resolve in the hosted sandbox`,
    );
  }
});

test("the text a user or agent sees makes no claim the guide forbids", async () => {
  // Scoped to the strings PayBox and the agent actually surface: tool titles,
  // tool descriptions, and the proposal summary. Dependencies' internals are
  // not plugin text.
  const list = await rpc("tools/list", {});
  const tools = (list.result?.tools ?? []) as Array<{ title?: string; description?: string }>;
  const visible: string[] = [];
  for (const tool of tools) {
    if (tool.title) visible.push(tool.title);
    if (tool.description) visible.push(tool.description);
  }

  const proposal = await callTool("propose_usdc_payment", CALLS[2]?.args ?? {});
  for (const block of proposal.content as Array<{ text?: string }>) {
    if (block.text) visible.push(block.text);
  }

  const haystack = visible.join("\n").toLowerCase();
  assert.ok(haystack.length > 500, "expected the tool text to be present for scanning");

  for (const claim of FORBIDDEN_CLAIMS) {
    assert.equal(haystack.includes(claim), false, `plugin text contains the forbidden claim "${claim}"`);
  }
});

test("the proposal summary attributes simulation and fees honestly", async () => {
  const result = await callTool("propose_usdc_payment", CALLS[2]?.args ?? {});
  const summary = (result.content as Array<{ text: string }>)[0]?.text ?? "";

  // PayBox, not this plugin, simulates.
  assert.match(summary, /PayBox selects the wallet, simulates the call/);
  // "A proposal is not a receipt."
  assert.match(summary, /not a receipt/);
  assert.match(summary, /does not guarantee/);
  // "The wallet still needs native currency for network fees."
  assert.match(summary, /needs a little ETH on Base to pay the network fee/);
  // And no fee or gas number is invented anywhere.
  assert.doesNotMatch(summary, /\d+(\.\d+)?\s*(gwei|wei of gas|gas)\b/i);
});
