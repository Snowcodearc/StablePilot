// What-if simulation logic.
//
// Two sources of truth, kept apart on purpose:
//   - plan_stablecoin_allocation decides the allocation;
//   - check_payment_policy decides whether the hypothetical purchase passes.
// This module never decides either. It validates the form, maps the inputs to
// the tools' documented arguments, and does the one arithmetic step the
// interface is allowed to do: starting balance minus purchase amount.
//
// propose_usdc_payment is deliberately absent. A simulation cannot advance to
// a payment proposal.

import { amount, amountError, fromAtoms, money, toAtoms } from "./format.js";

export const PLAN_TOOL = "plan_stablecoin_allocation";
export const POLICY_TOOL = "check_payment_policy";

/** The only two plugin tools a simulation may call. */
export const SIMULATION_TOOLS = [PLAN_TOOL, POLICY_TOOL];

const DECISIONS = new Set(["allowed", "blocked", "review_required"]);

const text = (value) => String(value ?? "").trim();

/**
 * Field-level validation for the simulator form.
 *
 * Uses the same decimal grammar as every other form (and the plugin) via
 * `amountError`, then adds the two rules that are specific to a what-if spend:
 * the amount must be greater than zero, and it may not exceed the supplied
 * balance. Overdrafts are not modelled.
 */
export function validateSimulation(values) {
  const errors = {
    purchaseAmountUsdc: amountError(values.purchaseAmountUsdc, { label: "Purchase amount" }),
    availableUsdc: amountError(values.availableUsdc, { label: "Available balance" }),
    spendingUsdc: amountError(values.spendingUsdc, { label: "Spending allocation" }),
    savingsUsdc: amountError(values.savingsUsdc, { label: "Savings allocation" }),
    emergencyReserveUsdc: amountError(values.emergencyReserveUsdc, { label: "Emergency reserve" }),
    savingsGoalUsdc: amountError(values.savingsGoalUsdc, { label: "Savings goal", required: false }),
    maxPaymentUsdc: amountError(values.maxPaymentUsdc, { label: "Maximum per payment", required: false }),
    minEmergencyReserveUsdc: amountError(values.minEmergencyReserveUsdc, {
      label: "Reserve floor",
      required: false,
    }),
  };

  if (!errors.purchaseAmountUsdc) {
    const purchase = toAtoms(values.purchaseAmountUsdc);
    if (purchase === 0n) {
      errors.purchaseAmountUsdc = "Purchase amount must be greater than zero.";
    }
  }

  if (!errors.purchaseAmountUsdc && !errors.availableUsdc) {
    const purchase = toAtoms(values.purchaseAmountUsdc);
    const balance = toAtoms(values.availableUsdc);
    if (purchase > balance) {
      errors.purchaseAmountUsdc =
        `Purchase amount is ${amount(values.purchaseAmountUsdc)}, more than the ` +
        `${amount(values.availableUsdc)} balance you supplied. This simulator does not model overdrafts.`;
    }
  }

  return errors;
}

export function hasErrors(errors) {
  return Object.values(errors).some(Boolean);
}

/** Arguments for plan_stablecoin_allocation, using only its documented fields. */
export function buildPlanArguments(values) {
  const args = {
    totalUsdc: text(values.availableUsdc),
    spendingUsdc: text(values.spendingUsdc),
    savingsUsdc: text(values.savingsUsdc),
    emergencyReserveUsdc: text(values.emergencyReserveUsdc),
  };
  if (text(values.savingsGoalUsdc)) args.savingsGoalUsdc = text(values.savingsGoalUsdc);
  return args;
}

/**
 * Arguments for check_payment_policy.
 *
 * The spending allocation and emergency reserve come from the plugin's own
 * plan, not from the raw form, so the policy check judges the allocation the
 * plugin actually produced. The optional description/merchant is not sent:
 * the policy tool accepts an EVM recipient address, not a merchant name.
 */
export function buildPolicyArguments(values, plan) {
  const args = {
    availableUsdc: plan.totalUsdc,
    spendingAllocationUsdc: plan.spendingUsdc,
    emergencyReserveUsdc: plan.emergencyReserveUsdc,
    paymentAmountUsdc: text(values.purchaseAmountUsdc),
  };
  if (text(values.maxPaymentUsdc)) args.maxPaymentUsdc = text(values.maxPaymentUsdc);
  if (text(values.minEmergencyReserveUsdc)) args.minEmergencyReserveUsdc = text(values.minEmergencyReserveUsdc);
  return args;
}

function isPlanLike(plan) {
  return (
    plan &&
    typeof plan === "object" &&
    [plan.totalUsdc, plan.spendingUsdc, plan.savingsUsdc, plan.emergencyReserveUsdc].every(
      (value) => typeof value === "string" && toAtoms(value) !== null,
    )
  );
}

function isPolicyLike(policy) {
  return (
    policy &&
    typeof policy === "object" &&
    DECISIONS.has(policy.decision) &&
    Array.isArray(policy.rules) &&
    [policy.remainingSpendingUsdc, policy.reserveAfterPaymentUsdc, policy.reserveFloorUsdc].every(
      (value) => typeof value === "string" && toAtoms(value) !== null,
    )
  );
}

/**
 * Local arithmetic only: starting balance minus the hypothetical purchase.
 * Allocation and policy figures are passed through from the plugin.
 */
export function computePreview(values, plan, policy) {
  const start = toAtoms(values.availableUsdc);
  const purchase = toAtoms(values.purchaseAmountUsdc);
  const spending = toAtoms(plan.spendingUsdc);
  const remaining = start - purchase;
  const overSpending = purchase > spending ? purchase - spending : 0n;
  const headroom = purchase <= spending ? spending - purchase : 0n;

  return {
    amount: fromAtoms(purchase),
    balanceBefore: fromAtoms(start),
    balanceAfter: fromAtoms(remaining),
    spendingBefore: plan.spendingUsdc,
    spendingAfter: policy.remainingSpendingUsdc,
    overSpending: fromAtoms(overSpending),
    spendingHeadroom: fromAtoms(headroom),
    savingsBefore: plan.savingsUsdc,
    savingsAfter: plan.savingsUsdc,
    // The reserve allocation is a floor, not a balance: a purchase comes out of
    // the spending allocation and does not reduce the reserve. The policy tool
    // separately reports the balance left after payment against that floor.
    reserveBefore: plan.emergencyReserveUsdc,
    reserveAfter: plan.emergencyReserveUsdc,
    reserveFloor: policy.reserveFloorUsdc,
    reserveBalanceAfter: policy.reserveAfterPaymentUsdc,
    savingsGoal: plan.savingsGoal ?? { provided: false, targetUsdc: null, meetsGoal: null, shortfallUsdc: null },
  };
}

function notPassing(policy) {
  return policy.rules.filter((rule) => rule.status !== "pass");
}

/**
 * The plain-language impact summary. Every figure and verdict is taken from
 * the simulation result; no sentence is hardcoded to a particular amount.
 */
export function impactSummary(result) {
  const { preview, policy, description } = result;
  const merchant = description ? ` on "${description}"` : "";
  const lines = [
    `After this hypothetical ${money(preview.amount)} USDC purchase${merchant}, ` +
      `your estimated remaining balance would be ${money(preview.balanceAfter)} USDC.`,
  ];

  if (policy.decision === "allowed") {
    lines.push(
      "The plugin's payment policy allows this purchase based on the figures supplied. " +
        (policy.remainingSpendingUsdc === "0"
          ? "It uses the whole spending allocation."
          : `It leaves ${money(policy.remainingSpendingUsdc)} USDC of the spending allocation.`),
    );
  } else if (policy.decision === "blocked") {
    const reasons = notPassing(policy).map((rule) => rule.message);
    lines.push(
      `The plugin's payment policy blocks this purchase. ${reasons.join(" ")} ` +
        "A blocked result is shown as returned; the simulator does not override it.",
    );
  } else {
    const reasons = notPassing(policy).map((rule) => rule.message);
    lines.push(
      `The plugin's payment policy returns review required. ${reasons.join(" ")}`,
    );
  }

  if (preview.savingsGoal.provided !== true) {
    lines.push(
      "No savings goal was supplied, so the effect on savings-goal progress cannot be shown.",
    );
  }

  return lines.join(" ");
}

function messageOf(toolResult, fallback) {
  return toolResult?.content?.[0]?.text ?? fallback;
}

/**
 * Runs one simulation: validate, plan, then check the hypothetical purchase.
 *
 * `callTool` is the real API client in the browser and an injected fake in the
 * tests. A transport failure, a plugin refusal, or a malformed response never
 * becomes a successful simulation.
 */
export async function runSimulation(values, callTool, { now = () => new Date().toISOString() } = {}) {
  const errors = validateSimulation(values);
  if (hasErrors(errors)) return { status: "invalid", errors };

  let planCall;
  try {
    planCall = await callTool(PLAN_TOOL, buildPlanArguments(values));
  } catch (error) {
    return { status: "error", stage: PLAN_TOOL, error };
  }

  const planResult = planCall?.result;
  if (planResult?.isError === true) {
    return {
      status: "incomplete",
      stage: PLAN_TOOL,
      message: messageOf(planResult, "The allocation tool could not build a plan for these figures."),
    };
  }
  const plan = planResult?.structuredContent?.plan;
  if (!isPlanLike(plan)) {
    return {
      status: "incomplete",
      stage: PLAN_TOOL,
      message: "The allocation tool did not return a usable plan, so the simulator will not guess at one.",
    };
  }

  let policyCall;
  try {
    policyCall = await callTool(POLICY_TOOL, buildPolicyArguments(values, plan));
  } catch (error) {
    return { status: "error", stage: POLICY_TOOL, error, plan, planDurationMs: planCall?.durationMs };
  }

  const policyResult = policyCall?.result;
  if (policyResult?.isError === true) {
    return {
      status: "incomplete",
      stage: POLICY_TOOL,
      message: messageOf(policyResult, "The policy tool could not evaluate this purchase."),
      plan,
    };
  }
  const policy = policyResult?.structuredContent?.result;
  if (!isPolicyLike(policy)) {
    return {
      status: "incomplete",
      stage: POLICY_TOOL,
      message: "The policy tool did not return a usable decision, so this simulation is incomplete.",
      plan,
    };
  }

  let preview;
  try {
    preview = computePreview(values, plan, policy);
  } catch {
    return {
      status: "incomplete",
      stage: POLICY_TOOL,
      message: "The plugin's figures could not be reconciled, so this simulation is incomplete.",
      plan,
    };
  }

  return {
    status: "ok",
    decision: policy.decision,
    plan,
    policy,
    preview,
    description: text(values.description),
    at: now(),
    planDurationMs: planCall?.durationMs ?? 0,
    policyDurationMs: policyCall?.durationMs ?? 0,
  };
}
