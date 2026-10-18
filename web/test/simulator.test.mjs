// What-If Simulator tests.
//
// The pure logic, the tool mapping and the rendered states, all without a
// browser. The end-to-end proof against the real plugin lives in
// adapter.test.mjs.
//
//   node --test web/test/

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  PLAN_TOOL,
  POLICY_TOOL,
  SIMULATION_TOOLS,
  buildPlanArguments,
  buildPolicyArguments,
  computePreview,
  impactSummary,
  runSimulation,
  validateSimulation,
} from "../public/lib/simulate.js";
import {
  SIMULATION_NOTICE,
  renderIncomplete,
  renderSimulation,
  renderToolError,
  simulatorShell,
} from "../public/views/simulator.js";

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const VALUES = {
  purchaseAmountUsdc: "150",
  description: "Headphones",
  availableUsdc: "1000",
  spendingUsdc: "300",
  savingsUsdc: "500",
  emergencyReserveUsdc: "200",
  savingsGoalUsdc: "600",
  maxPaymentUsdc: "100",
  minEmergencyReserveUsdc: "",
};

const PLAN = {
  totalUsdc: "1000",
  spendingUsdc: "300",
  savingsUsdc: "500",
  emergencyReserveUsdc: "200",
  totalAllocatedUsdc: "1000",
  unallocatedUsdc: "0",
  percentages: {
    spending: "30.00",
    savings: "50.00",
    emergencyReserve: "20.00",
    allocated: "100.00",
    unallocated: "0.00",
  },
  savingsGoal: { provided: true, targetUsdc: "600", meetsGoal: false, shortfallUsdc: "100" },
  notes: [],
  explanation: "Plan explanation.",
};

const RULE = (rule, status = "pass", severity = "soft", message = "Rule passed.") => ({
  rule,
  status,
  severity,
  message,
});

const POLICY = {
  decision: "allowed",
  paymentAmountUsdc: "150",
  spendingAllocationUsdc: "300",
  remainingSpendingUsdc: "150",
  availableUsdc: "1000",
  reserveFloorUsdc: "200",
  reserveAfterPaymentUsdc: "850",
  rules: [
    RULE("allocation_consistency"),
    RULE("spending_budget"),
    RULE("per_payment_limit"),
    RULE("emergency_reserve"),
  ],
  blockedBy: [],
  reviewReasons: [],
  explanation: "Decision: allowed.",
};

const BLOCKED_POLICY = {
  ...POLICY,
  decision: "blocked",
  remainingSpendingUsdc: "0",
  rules: [
    RULE("allocation_consistency"),
    RULE("spending_budget", "fail", "hard", "The payment of 350 USDC exceeds the 300 USDC spending allocation by 50 USDC."),
    RULE("per_payment_limit", "fail", "hard", "The payment of 350 USDC exceeds the per-payment limit of 100 USDC."),
    RULE("emergency_reserve"),
  ],
  blockedBy: ["spending_budget", "per_payment_limit"],
  explanation: "Decision: blocked.",
};

const REVIEW_POLICY = {
  ...POLICY,
  decision: "review_required",
  rules: [
    RULE("allocation_consistency"),
    RULE("spending_budget"),
    RULE("per_payment_limit", "unknown", "soft", "No maximum individual payment limit was supplied."),
    RULE("emergency_reserve"),
  ],
  reviewReasons: ["per_payment_limit"],
  explanation: "Decision: review_required.",
};

function fakeCall({ plan = PLAN, policy = POLICY, planError = null, policyError = null } = {}) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    if (name === PLAN_TOOL) {
      if (planError) throw planError;
      return { result: { structuredContent: { status: "planned", plan } }, durationMs: 3 };
    }
    if (name === POLICY_TOOL) {
      if (policyError) throw policyError;
      return { result: { structuredContent: { status: "checked", decision: policy.decision, result: policy } }, durationMs: 7 };
    }
    throw new Error(`Unexpected tool ${name}`);
  };
  fn.calls = calls;
  return fn;
}

describe("input validation", () => {
  it("accepts a complete set of valid figures", () => {
    const errors = validateSimulation(VALUES);
    assert.deepEqual(Object.values(errors).filter(Boolean), []);
  });

  it("rejects an empty purchase amount", () => {
    const errors = validateSimulation({ ...VALUES, purchaseAmountUsdc: "" });
    assert.equal(errors.purchaseAmountUsdc, "Purchase amount is required.");
  });

  it("rejects zero and negative purchase amounts", () => {
    assert.match(validateSimulation({ ...VALUES, purchaseAmountUsdc: "0" }).purchaseAmountUsdc, /greater than zero/);
    assert.match(validateSimulation({ ...VALUES, purchaseAmountUsdc: "-1" }).purchaseAmountUsdc, /cannot be negative/);
  });

  it("rejects non-numeric, malformed and non-finite values", () => {
    for (const value of ["abc", "1,000", "1.2.3", "12abc", "$500", "1e3", "NaN", "Infinity", "0x10"]) {
      const errors = validateSimulation({ ...VALUES, purchaseAmountUsdc: value });
      assert.ok(errors.purchaseAmountUsdc, `${value} should be rejected`);
    }
  });

  it("rejects more precision than USDC supports", () => {
    assert.match(
      validateSimulation({ ...VALUES, purchaseAmountUsdc: "1.1234567" }).purchaseAmountUsdc,
      /six decimal places/,
    );
  });

  it("rejects a negative balance", () => {
    const errors = validateSimulation({ ...VALUES, availableUsdc: "-5" });
    assert.match(errors.availableUsdc, /cannot be negative/);
  });

  it("rejects a purchase greater than the supplied balance", () => {
    const errors = validateSimulation({ ...VALUES, purchaseAmountUsdc: "1000.01" });
    assert.match(errors.purchaseAmountUsdc, /more than the 1,000 USDC balance/);
    assert.match(errors.purchaseAmountUsdc, /does not model overdrafts/);
  });

  it("accepts a purchase equal to the balance", () => {
    const errors = validateSimulation({ ...VALUES, purchaseAmountUsdc: "1000" });
    assert.equal(errors.purchaseAmountUsdc, null);
  });

  it("keeps valid decimal amounts exactly as typed", () => {
    const values = { ...VALUES, purchaseAmountUsdc: "100.50" };
    assert.equal(validateSimulation(values).purchaseAmountUsdc, null);
    assert.equal(values.purchaseAmountUsdc, "100.50");
  });
});

describe("tool arguments", () => {
  it("calls only the allocation and policy tools", () => {
    assert.deepEqual(SIMULATION_TOOLS, [PLAN_TOOL, POLICY_TOOL]);
    assert.equal(SIMULATION_TOOLS.includes("propose_usdc_payment"), false);
  });

  it("maps the plan to the documented input schema", () => {
    assert.deepEqual(buildPlanArguments(VALUES), {
      totalUsdc: "1000",
      spendingUsdc: "300",
      savingsUsdc: "500",
      emergencyReserveUsdc: "200",
      savingsGoalUsdc: "600",
    });
  });

  it("omits an empty savings goal instead of sending an empty string", () => {
    assert.deepEqual(buildPlanArguments({ ...VALUES, savingsGoalUsdc: "" }), {
      totalUsdc: "1000",
      spendingUsdc: "300",
      savingsUsdc: "500",
      emergencyReserveUsdc: "200",
    });
  });

  it("gives the policy tool the plugin's allocation and the hypothetical amount", () => {
    const args = buildPolicyArguments(VALUES, PLAN);
    assert.deepEqual(args, {
      availableUsdc: "1000",
      spendingAllocationUsdc: "300",
      emergencyReserveUsdc: "200",
      paymentAmountUsdc: "150",
      maxPaymentUsdc: "100",
    });
    assert.equal("recipient" in args, false);
    assert.equal("description" in args, false);
    assert.equal("propose" in args, false);
  });

  it("takes the allocation from the plugin's plan, not from the raw form", () => {
    const args = buildPolicyArguments(VALUES, { ...PLAN, spendingUsdc: "320", emergencyReserveUsdc: "180" });
    assert.equal(args.spendingAllocationUsdc, "320");
    assert.equal(args.emergencyReserveUsdc, "180");
  });

  it("omits optional limits that were left blank", () => {
    const args = buildPolicyArguments({ ...VALUES, maxPaymentUsdc: "", minEmergencyReserveUsdc: "" }, PLAN);
    assert.equal("maxPaymentUsdc" in args, false);
    assert.equal("minEmergencyReserveUsdc" in args, false);
  });
});

describe("simulation orchestration", () => {
  it("plans first, then checks the hypothetical purchase", async () => {
    const call = fakeCall();
    const outcome = await runSimulation(VALUES, call, { now: () => "2026-10-18T16:00:00.000Z" });

    assert.equal(outcome.status, "ok");
    assert.deepEqual(
      call.calls.map((entry) => entry.name),
      [PLAN_TOOL, POLICY_TOOL],
    );
    assert.deepEqual(call.calls[1].args, buildPolicyArguments(VALUES, PLAN));
    assert.equal(outcome.decision, "allowed");
    assert.equal(outcome.at, "2026-10-18T16:00:00.000Z");
  });

  it("keeps a blocked plugin result blocked", async () => {
    const outcome = await runSimulation({ ...VALUES, purchaseAmountUsdc: "350" }, fakeCall({ policy: BLOCKED_POLICY }));
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.decision, "blocked");
    assert.deepEqual(outcome.policy.blockedBy, ["spending_budget", "per_payment_limit"]);
  });

  it("keeps a review-required plugin result review-required", async () => {
    const outcome = await runSimulation(VALUES, fakeCall({ policy: REVIEW_POLICY }));
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.decision, "review_required");
    assert.deepEqual(outcome.policy.reviewReasons, ["per_payment_limit"]);
  });

  it("does not check the policy when the allocation tool refuses", async () => {
    const call = fakeCall();
    call.calls.length = 0;
    const refusing = async (name) => {
      call.calls.push({ name });
      return {
        result: {
          isError: true,
          content: [{ type: "text", text: "The allocations total more than the balance." }],
        },
        durationMs: 2,
      };
    };
    const outcome = await runSimulation(VALUES, refusing);
    assert.equal(outcome.status, "incomplete");
    assert.equal(outcome.stage, PLAN_TOOL);
    assert.match(outcome.message, /more than the balance/);
    assert.deepEqual(call.calls.map((entry) => entry.name), [PLAN_TOOL]);
  });

  it("turns a policy tool error into an incomplete simulation, not a success", async () => {
    const refusing = async (name) =>
      name === PLAN_TOOL
        ? { result: { structuredContent: { plan: PLAN } } }
        : { result: { isError: true, content: [{ type: "text", text: "Policy figures conflicted." }] } };
    const incomplete = await runSimulation(VALUES, refusing);
    assert.equal(incomplete.status, "incomplete");
    assert.equal(incomplete.stage, POLICY_TOOL);
    assert.match(incomplete.message, /conflicted/);
    assert.equal(incomplete.decision, undefined);
  });

  it("reports a transport failure as an error", async () => {
    const outcome = await runSimulation(VALUES, fakeCall({ planError: new Error("backend offline") }));
    assert.equal(outcome.status, "error");
    assert.equal(outcome.stage, PLAN_TOOL);
    assert.match(outcome.error.message, /offline/);
  });

  it("rejects a malformed tool response rather than inventing a result", async () => {
    const empty = async (name) => ({ result: name === PLAN_TOOL ? { structuredContent: {} } : { structuredContent: {} } });
    const missingPlan = await runSimulation(VALUES, empty);
    assert.equal(missingPlan.status, "incomplete");
    assert.equal(missingPlan.stage, PLAN_TOOL);

    const badPolicy = async (name) => ({
      result:
        name === PLAN_TOOL
          ? { structuredContent: { plan: PLAN } }
          : { structuredContent: { result: { decision: "yes", remainingSpendingUsdc: "0", reserveAfterPaymentUsdc: "850" } } },
    });
    const missingPolicy = await runSimulation(VALUES, badPolicy);
    assert.equal(missingPolicy.status, "incomplete");
    assert.equal(missingPolicy.stage, POLICY_TOOL);
  });

  it("never calls any tool outside the simulation whitelist", async () => {
    const call = fakeCall();
    await runSimulation(VALUES, call);
    for (const entry of call.calls) assert.ok(SIMULATION_TOOLS.includes(entry.name), entry.name);
  });
});

describe("local arithmetic", () => {
  it("estimates 850 USDC left from a 1,000 balance and a 150 purchase", () => {
    const preview = computePreview(VALUES, PLAN, POLICY);
    assert.equal(preview.balanceBefore, "1000");
    assert.equal(preview.balanceAfter, "850");
    assert.equal(preview.amount, "150");
    assert.equal(preview.overSpending, "0");
    assert.equal(preview.spendingHeadroom, "150");
  });

  it("computes the amount over the spending allocation", () => {
    const preview = computePreview({ ...VALUES, purchaseAmountUsdc: "350" }, PLAN, BLOCKED_POLICY);
    assert.equal(preview.balanceAfter, "650");
    assert.equal(preview.overSpending, "50");
    assert.equal(preview.spendingHeadroom, "0");
  });

  it("keeps the reserve as a floor and shows the policy's balance after payment separately", () => {
    const preview = computePreview(VALUES, PLAN, POLICY);
    assert.equal(preview.savingsBefore, "500");
    assert.equal(preview.savingsAfter, "500");
    assert.equal(preview.reserveBefore, "200");
    assert.equal(preview.reserveAfter, "200");
    assert.equal(preview.reserveFloor, "200");
    assert.equal(preview.reserveBalanceAfter, "850");
  });

  it("subtracts decimals without floating point drift", () => {
    const values = { ...VALUES, availableUsdc: "1000.50", purchaseAmountUsdc: "0.25" };
    const preview = computePreview(values, PLAN, POLICY);
    assert.equal(preview.balanceAfter, "1000.25");
  });
});

describe("impact summary", () => {
  const outcome = (policy = POLICY, plan = PLAN, values = VALUES) => ({
    preview: computePreview(values, plan, policy),
    policy,
    plan,
    description: values.description,
  });

  it("states the actual estimated balance and the plugin's allowed verdict", () => {
    const summary = impactSummary(outcome());
    assert.match(summary, /hypothetical 150 USDC purchase on "Headphones"/);
    assert.match(summary, /estimated remaining balance would be 850 USDC/);
    assert.match(summary, /payment policy allows this purchase/);
  });

  it("quotes the plugin's blocking reasons", () => {
    const summary = impactSummary(outcome(BLOCKED_POLICY, PLAN, { ...VALUES, purchaseAmountUsdc: "350" }));
    assert.match(summary, /payment policy blocks this purchase/);
    assert.match(summary, /exceeds the 300 USDC spending allocation by 50 USDC/);
    assert.match(summary, /does not override it/);
  });

  it("says what is missing instead of inventing goal progress", () => {
    const plan = { ...PLAN, savingsGoal: { provided: false, targetUsdc: null, meetsGoal: null, shortfallUsdc: null } };
    const summary = impactSummary(outcome(POLICY, plan));
    assert.match(summary, /No savings goal was supplied/);
    assert.equal(/goal progress would be/.test(summary), false);
  });
});

describe("interface states", () => {
  it("shows the persistent simulation notice and the opt-in fields", () => {
    const html = simulatorShell({ ...VALUES });
    assert.match(html, /Simulation only\. No funds have been moved\./);
    assert.match(html, /id="purchaseAmountUsdc"/);
    assert.match(html, /id="availableUsdc"/);
    assert.match(html, /not a verified on-chain balance/i);
    assert.match(html, /Does not create a payment proposal|cannot create a payment proposal/i);
  });

  it("labels the balance estimate separately from plugin figures", () => {
    const outcome = {
      status: "ok",
      decision: "allowed",
      plan: PLAN,
      policy: POLICY,
      preview: computePreview(VALUES, PLAN, POLICY),
      description: "Headphones",
      at: "2026-10-18T16:00:00.000Z",
    };
    const html = renderSimulation(outcome);
    assert.match(html, /850 USDC/);
    assert.match(html, /Balance after payment vs\. reserve floor/);
    assert.match(html, /850 USDC left · floor 200 USDC/);
    assert.match(html, /data-source="estimate">Estimate/);
    assert.match(html, /data-source="plugin">Plugin/);
    assert.match(html, /Savings goal/);
    assert.match(html, /Short by 100 USDC/);
    assert.match(html, /Simulation only\. No funds have been moved\./);
    assert.match(html, /No payment proposal was created/);
    assert.equal(/transaction hash exists for a simulation/.test(html), true);
  });

  it("keeps a blocked verdict visible as blocked", () => {
    const outcome = {
      status: "ok",
      decision: "blocked",
      plan: PLAN,
      policy: BLOCKED_POLICY,
      preview: computePreview({ ...VALUES, purchaseAmountUsdc: "350" }, PLAN, BLOCKED_POLICY),
      description: "",
      at: "2026-10-18T16:00:00.000Z",
    };
    const html = renderSimulation(outcome);
    assert.match(html, /data-decision="blocked"/);
    assert.match(html, /Blocked/);
    assert.match(html, /Over the spending limit/);
  });

  it("does not show a savings-goal row when no goal was supplied", () => {
    const plan = { ...PLAN, savingsGoal: { provided: false, targetUsdc: null, meetsGoal: null, shortfallUsdc: null } };
    const outcome = {
      status: "ok",
      decision: "review_required",
      plan,
      policy: REVIEW_POLICY,
      preview: computePreview(VALUES, plan, REVIEW_POLICY),
      description: "",
      at: "2026-10-18T16:00:00.000Z",
    };
    const html = renderSimulation(outcome);
    assert.equal(html.includes("target"), false);
    assert.match(html, /No savings goal was supplied/);
    assert.match(html, /data-decision="review_required"/);
  });

  it("renders incomplete and error states without inventing a verdict", () => {
    const incomplete = renderIncomplete({ stage: PLAN_TOOL, message: "Allocation figures conflicted." });
    assert.match(incomplete, /Simulation incomplete/);
    assert.match(incomplete, /Allocation figures conflicted\./);
    assert.match(incomplete, /No verdict was produced/);
    assert.equal(incomplete.includes("Allowed"), false);

    const error = renderToolError({ stage: POLICY_TOOL, error: new Error("timed out") });
    assert.match(error, /Could not run the simulation/);
    assert.match(error, /timed out/);
    assert.match(error, /failed tool call is not a successful simulation/);
    assert.match(error, /data-retry/);
  });
});

describe("dashboard integration", () => {
  it("registers the route and the navigation item", async () => {
    const app = await source("../public/app.js");
    assert.match(app, /"\/simulator": \{ title: "What-If Simulator"/);
    const html = await source("../public/index.html");
    assert.match(html, /href="\/simulator" data-route="\/simulator"/);
    assert.match(html, /What-If Simulator/);
  });

  it("does not reference the proposal tool from the simulator logic", async () => {
    const logic = await source("../public/lib/simulate.js");
    // The only mention is the header comment explaining why it is absent.
    const calls = logic.match(/callTool\([^)]*\)/g) ?? [];
    for (const call of calls) assert.equal(call.includes("propose"), false);
  });

  it("does not write settings, plans, reports or proposals from the simulator", async () => {
    const view = await source("../public/views/simulator.js");
    for (const forbidden of ["updateSettings", "setLastPlan", "setLastReport", "propose_usdc_payment"]) {
      assert.equal(view.includes(forbidden), false, `${forbidden} must not be used`);
    }
  });
});
