// End-to-end checks for the web adapter.
//
// These drive the real `dist/plugin.mjs` through the same HTTP endpoints the
// browser uses. Nothing is mocked: if a tool call succeeds here, the interface
// gets a genuine plugin response.
//
//   node --test web/test/
//
// Each tool call spawns the plugin as a child process, so the whole file takes
// roughly 20 seconds on a laptop.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOL as SPLIT_TOOL, planPayload, splitAmount } from "../public/lib/split.js";
import { runSimulation } from "../public/lib/simulate.js";

const serverEntry = fileURLToPath(new URL("../server/index.mjs", import.meta.url));

let child;
let base = "";

before(async () => {
  child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  base = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${buffered}`)), 10_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const match = /listening on (http:\/\/\S+)/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      buffered += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}:\n${buffered}`));
    });
  });
});

after(() => {
  child?.kill();
});

async function get(path) {
  const response = await fetch(new URL(path, base));
  return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
}

async function call(tool, args) {
  const response = await fetch(new URL(`/api/tools/${tool}`, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const payload = await response.json();
  return { status: response.status, payload, result: payload.result };
}

const PLAN_ARGS = {
  totalUsdc: "1000",
  spendingUsdc: "300",
  savingsUsdc: "500",
  emergencyReserveUsdc: "200",
};

const RECIPIENT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

describe("plugin discovery", () => {
  it("reports the artifact it is driving", async () => {
    const { status, body } = await get("/api/health");
    assert.equal(status, 200);
    const health = JSON.parse(body);
    assert.equal(health.ok, true);
    assert.match(health.artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(health.artifact.bytes > 100_000, "bundle should be a real build");
    assert.deepEqual([...health.tools].sort(), [
      "check_payment_policy",
      "get_allocation_report",
      "plan_stablecoin_allocation",
      "propose_usdc_payment",
    ]);
    assert.equal(JSON.stringify(health).includes("privateKey"), false);
  });

  it("exposes the schemas the browser forms are built from", async () => {
    const { status, body } = await get("/api/tools");
    assert.equal(status, 200);
    const { tools } = JSON.parse(body);

    const plan = tools.find((tool) => tool.name === "plan_stablecoin_allocation");
    assert.deepEqual(plan.inputSchema.required, [
      "totalUsdc",
      "spendingUsdc",
      "savingsUsdc",
      "emergencyReserveUsdc",
    ]);

    const propose = tools.find((tool) => tool.name === "propose_usdc_payment");
    assert.deepEqual(propose.inputSchema.required, [
      "chain",
      "recipient",
      "amountUsdc",
      "availableUsdc",
      "spendingAllocationUsdc",
      "emergencyReserveUsdc",
    ]);
  });
});

describe("plan_stablecoin_allocation", () => {
  it("splits 1,000 into 300 / 500 / 200 and misses a 600 savings goal", async () => {
    const { status, payload } = await call("plan_stablecoin_allocation", {
      ...PLAN_ARGS,
      savingsGoalUsdc: "600",
    });

    assert.equal(status, 200);
    assert.equal(payload.result.isError, undefined);
    const plan = payload.result.structuredContent.plan;

    assert.equal(plan.totalAllocatedUsdc, "1000");
    assert.equal(plan.unallocatedUsdc, "0");
    assert.deepEqual(plan.percentages, {
      spending: "30.00",
      savings: "50.00",
      emergencyReserve: "20.00",
      allocated: "100.00",
      unallocated: "0.00",
    });
    assert.equal(plan.savingsGoal.provided, true);
    assert.equal(plan.savingsGoal.meetsGoal, false);
    assert.equal(plan.savingsGoal.shortfallUsdc, "100");
    assert.ok(payload.durationMs < 10_000, "hosted budget is 10s per operation");
  });

  it("refuses an over-allocation", async () => {
    const { payload } = await call("plan_stablecoin_allocation", {
      totalUsdc: "1000",
      spendingUsdc: "900",
      savingsUsdc: "500",
      emergencyReserveUsdc: "200",
    });

    assert.equal(payload.result.isError, true);
    assert.match(payload.result.content[0].text, /1600/);
  });

  it("refuses a malformed amount", async () => {
    const { payload } = await call("plan_stablecoin_allocation", { ...PLAN_ARGS, totalUsdc: "1,000" });
    assert.equal(payload.result.isError, true);
  });
});

describe("smart split", () => {
  it("sends the panel's own payload to plan_stablecoin_allocation", async () => {
    assert.equal(SPLIT_TOOL, "plan_stablecoin_allocation");

    const { status, payload } = await call(SPLIT_TOOL, planPayload(splitAmount("1000")));
    assert.equal(status, 200);
    assert.equal(payload.result.isError, undefined);

    const plan = payload.result.structuredContent.plan;
    assert.equal(plan.totalAllocatedUsdc, "1000");
    assert.equal(plan.unallocatedUsdc, "0");
    assert.deepEqual(plan.percentages, {
      spending: "30.00",
      savings: "50.00",
      emergencyReserve: "20.00",
      allocated: "100.00",
      unallocated: "0.00",
    });
    assert.equal(typeof payload.result.structuredContent.explanation, "string");
  });

  it("gets 30/50/20 back for the minimum, a mid amount and a decimal", async () => {
    for (const input of ["100", "250", "123.45"]) {
      const { payload } = await call(SPLIT_TOOL, planPayload(splitAmount(input)));
      const plan = payload.result.structuredContent.plan;
      assert.equal(plan.totalAllocatedUsdc, input, `${input} total`);
      assert.equal(plan.unallocatedUsdc, "0", `${input} unallocated`);
      assert.equal(plan.percentages.spending, "30.00", `${input} spending`);
      assert.equal(plan.percentages.savings, "50.00", `${input} savings`);
      assert.equal(plan.percentages.emergencyReserve, "20.00", `${input} reserve`);
    }
  });

  it("reconciles the plugin's own figures for an amount that does not divide evenly", async () => {
    const { payload } = await call(SPLIT_TOOL, planPayload(splitAmount("100.000001")));
    const plan = payload.result.structuredContent.plan;

    if (payload.result.isError) {
      // A refusal is acceptable only if it is explicit; it must never look like a plan.
      assert.match(payload.result.content[0].text, /error|allocat/i);
      return;
    }

    assert.equal(plan.unallocatedUsdc, "0");
    const sum =
      Number(plan.spendingUsdc) + Number(plan.savingsUsdc) + Number(plan.emergencyReserveUsdc);
    assert.ok(Math.abs(sum - 100.000001) < 1e-9, `summed to ${sum}`);
  });
});

describe("check_payment_policy", () => {
  const base = {
    availableUsdc: "1000",
    spendingAllocationUsdc: "300",
    emergencyReserveUsdc: "200",
  };

  it("allows a payment inside every rule", async () => {
    const { payload } = await call("check_payment_policy", {
      ...base,
      paymentAmountUsdc: "50",
      maxPaymentUsdc: "100",
    });

    const { decision, result } = payload.result.structuredContent;
    assert.equal(decision, "allowed");
    assert.ok(result.rules.length >= 4);
    assert.equal(result.remainingSpendingUsdc, "250");
    assert.deepEqual(result.blockedBy, []);
  });

  it("blocks a payment that breaks the spending budget", async () => {
    const { payload } = await call("check_payment_policy", {
      ...base,
      paymentAmountUsdc: "500",
      maxPaymentUsdc: "100",
    });

    const { decision, result } = payload.result.structuredContent;
    assert.equal(decision, "blocked");
    assert.ok(result.blockedBy.includes("spending_budget"));
    // 500 exceeds the 100 per-payment limit as well, and both are hard rules.
    assert.ok(result.blockedBy.includes("per_payment_limit"));
  });

  it("asks for review when no per-payment limit is supplied", async () => {
    const { payload } = await call("check_payment_policy", { ...base, paymentAmountUsdc: "25" });
    const { decision, result } = payload.result.structuredContent;
    assert.equal(decision, "review_required");
    assert.ok(result.reviewReasons.includes("per_payment_limit"));
  });
});

describe("propose_usdc_payment", () => {
  const base = {
    chain: "base",
    recipient: RECIPIENT,
    availableUsdc: "1000",
    spendingAllocationUsdc: "300",
    emergencyReserveUsdc: "200",
    maxPaymentUsdc: "100",
  };

  it("returns an unsigned EVM proposal in the PayBox envelope", async () => {
    const { payload } = await call("propose_usdc_payment", { ...base, amountUsdc: "25" });
    const proposal = payload.result.structuredContent["io.paybox/transactionProposal"];

    assert.equal(proposal.version, "1");
    assert.equal(proposal.kind, "evm");
    assert.equal(proposal.chain, "eip155:8453");
    assert.match(proposal.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(proposal.transaction.to.toLowerCase(), RECIPIENT);
    assert.equal(proposal.transaction.value, "0");
    assert.ok(proposal.transaction.data.startsWith("0xa9059cbb"), "ERC-20 transfer selector");
    assert.equal(JSON.stringify(proposal).includes("signature"), false);
  });

  it("builds no proposal when the payment needs review", async () => {
    const { payload } = await call("propose_usdc_payment", {
      ...base,
      maxPaymentUsdc: undefined,
      amountUsdc: "25",
    });

    assert.equal(payload.result.isError, true);
    assert.match(payload.result.content[0].text, /review_required/);
  });
});

describe("what-if simulator", () => {
  const values = {
    purchaseAmountUsdc: "150",
    description: "Headphones",
    availableUsdc: "1000",
    spendingUsdc: "300",
    savingsUsdc: "500",
    emergencyReserveUsdc: "200",
    savingsGoalUsdc: "600",
    maxPaymentUsdc: "200",
    minEmergencyReserveUsdc: "",
  };

  const invoke = async (name, args) => {
    const { payload } = await call(name, args);
    return { result: payload.result, durationMs: payload.durationMs };
  };

  it("plans and checks a hypothetical purchase through the real plugin", async () => {
    const outcome = await runSimulation(values, invoke);

    assert.equal(outcome.status, "ok", outcome.message ?? outcome.error?.message);
    assert.equal(outcome.decision, "allowed");
    assert.equal(outcome.plan.spendingUsdc, "300");
    assert.equal(outcome.policy.paymentAmountUsdc, "150");
    assert.equal(outcome.preview.balanceAfter, "850");
    assert.equal(outcome.plan.savingsGoal.shortfallUsdc, "100");
  });

  it("keeps the plugin's blocked result blocked", async () => {
    const outcome = await runSimulation({ ...values, purchaseAmountUsdc: "350" }, invoke);

    assert.equal(outcome.status, "ok");
    assert.equal(outcome.decision, "blocked");
    assert.ok(outcome.policy.blockedBy.includes("spending_budget"));
    assert.equal(outcome.preview.overSpending, "50");
  });

  it("keeps review required when the per-payment limit is missing", async () => {
    const outcome = await runSimulation({ ...values, maxPaymentUsdc: "" }, invoke);

    assert.equal(outcome.status, "ok");
    assert.equal(outcome.decision, "review_required");
    assert.ok(outcome.policy.reviewReasons.includes("per_payment_limit"));
  });

  it("never creates a payment proposal during a simulation", async () => {
    const calls = [];
    const tracked = async (name, args) => {
      calls.push(name);
      return invoke(name, args);
    };
    await runSimulation(values, tracked);

    assert.deepEqual(calls, ["plan_stablecoin_allocation", "check_payment_policy"]);
    assert.equal(calls.includes("propose_usdc_payment"), false);
  });
});

describe("static shell", () => {
  it("serves the app shell and its modules", async () => {
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /StablePilot/);

    for (const path of ["/app.js", "/styles.css", "/components.css", "/views/planner.js", "/views/simulator.js", "/lib/simulate.js"]) {
      const file = await get(path);
      assert.equal(file.status, 200, `${path} should be served`);
    }
  });

  it("falls back to the shell for client routes", async () => {
    const { status, body } = await get("/proposals");
    assert.equal(status, 200);
    assert.match(body, /<div id="view">/);
  });

  it("never serves files outside the public directory", async () => {
    // fetch() and the URL parser both fold some `..` forms before the request is
    // sent, so the property under test is that no file outside `public` is ever
    // returned: the server may reject the path or answer with the app shell.
    for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json"]) {
      const { status, body, type } = await get(path);
      assert.ok([200, 400, 404].includes(status), `${path} returned ${status}`);
      assert.equal(body.includes('"scripts"'), false, `${path} leaked package.json`);
      if (status === 200) assert.match(type, /text\/html/, `${path} served something other than the shell`);
    }
  });

  it("rejects unknown tools and endpoints", async () => {
    const tool = await fetch(new URL("/api/tools/delete_everything", base), { method: "POST", body: "{}" });
    assert.equal(tool.status, 404);

    const endpoint = await get("/api/nothing-here");
    assert.equal(endpoint.status, 404);
  });
});
