// Feature B: payment policy checker.
//
// The policy engine evaluates the inputs it is given. It is not a PayBox
// spending limit, and it is not a bank balance: PayBox performs its own
// authorization separately, and the user remains responsible for what they
// actually hold.

import { formatAtoms, parseAmount } from "./money.js";
import { validateRecipient } from "./validation.js";

export type PolicyDecision = "allowed" | "blocked" | "review_required";

export interface PolicyInput {
  availableUsdc: string;
  spendingAllocationUsdc: string;
  emergencyReserveUsdc: string;
  paymentAmountUsdc: string;
  maxPaymentUsdc?: string;
  minEmergencyReserveUsdc?: string;
  recipient?: string;
}

export interface PolicyRuleResult {
  rule: string;
  status: "pass" | "fail" | "unknown";
  severity: "hard" | "soft";
  message: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  paymentAmountUsdc: string;
  spendingAllocationUsdc: string;
  remainingSpendingUsdc: string;
  availableUsdc: string;
  reserveFloorUsdc: string;
  reserveAfterPaymentUsdc: string;
  rules: PolicyRuleResult[];
  blockedBy: string[];
  reviewReasons: string[];
  explanation: string;
}

export type PolicyOutcome = { ok: true; result: PolicyResult } | { ok: false; error: string; field: string };

interface Parsed {
  available: bigint;
  spending: bigint;
  reserve: bigint;
  amount: bigint;
  maxPayment: bigint | null;
  reserveFloor: bigint;
  reserveFloorFromOverride: boolean;
}

type ParsedField = { ok: true; atoms: bigint } | { ok: false; error: string; field: string };

function parseRequired(value: string, label: string, field: string): ParsedField {
  const parsed = parseAmount(value);
  if (!parsed.ok) return { ok: false, error: `Invalid ${label}: ${parsed.error}`, field };
  return { ok: true, atoms: parsed.atoms };
}

function parsePolicyInput(input: PolicyInput): { ok: true; values: Parsed } | { ok: false; error: string; field: string } {
  const available = parseRequired(input.availableUsdc, "available USDC", "availableUsdc");
  if (!available.ok) return available;
  const spending = parseRequired(input.spendingAllocationUsdc, "spending allocation", "spendingAllocationUsdc");
  if (!spending.ok) return spending;
  const reserve = parseRequired(input.emergencyReserveUsdc, "emergency reserve", "emergencyReserveUsdc");
  if (!reserve.ok) return reserve;
  const amount = parseRequired(input.paymentAmountUsdc, "proposed payment amount", "paymentAmountUsdc");
  if (!amount.ok) return amount;

  if (amount.atoms === 0n) {
    return {
      ok: false,
      error: "The proposed payment amount must be greater than zero. A zero amount is not a payment.",
      field: "paymentAmountUsdc",
    };
  }

  let maxPayment: bigint | null = null;
  if (input.maxPaymentUsdc !== undefined && input.maxPaymentUsdc !== null && input.maxPaymentUsdc !== "") {
    const parsedMax = parseAmount(input.maxPaymentUsdc);
    if (!parsedMax.ok) {
      return { ok: false, error: `Invalid maximum payment limit: ${parsedMax.error}`, field: "maxPaymentUsdc" };
    }
    maxPayment = parsedMax.atoms;
  }

  let reserveFloor = reserve.atoms;
  let reserveFloorFromOverride = false;
  if (
    input.minEmergencyReserveUsdc !== undefined &&
    input.minEmergencyReserveUsdc !== null &&
    input.minEmergencyReserveUsdc !== ""
  ) {
    const parsedFloor = parseAmount(input.minEmergencyReserveUsdc);
    if (!parsedFloor.ok) {
      return {
        ok: false,
        error: `Invalid minimum emergency reserve: ${parsedFloor.error}`,
        field: "minEmergencyReserveUsdc",
      };
    }
    reserveFloor = parsedFloor.atoms;
    reserveFloorFromOverride = true;
  }

  return {
    ok: true,
    values: {
      available: available.atoms,
      spending: spending.atoms,
      reserve: reserve.atoms,
      amount: amount.atoms,
      maxPayment,
      reserveFloor,
      reserveFloorFromOverride,
    },
  };
}

/** Evaluate a proposed payment against the supplied policy inputs. */
export function checkPolicy(input: PolicyInput): PolicyOutcome {
  const parsed = parsePolicyInput(input);
  if (!parsed.ok) return parsed;
  const v = parsed.values;

  const rules: PolicyRuleResult[] = [];

  // Rule 1: the stated allocations must be internally consistent.
  const allocationTotal = v.spending + v.reserve;
  if (allocationTotal > v.available) {
    rules.push({
      rule: "allocation_consistency",
      status: "unknown",
      severity: "soft",
      message:
        `The stated spending allocation (${formatAtoms(v.spending)} USDC) plus emergency reserve ` +
        `(${formatAtoms(v.reserve)} USDC) exceeds the available balance (${formatAtoms(v.available)} USDC). ` +
        "Correct the figures before this payment is judged.",
    });
  } else {
    rules.push({
      rule: "allocation_consistency",
      status: "pass",
      severity: "soft",
      message: "The stated spending allocation and emergency reserve fit within the available balance.",
    });
  }

  // Rule 2: the payment must fit inside the spending allocation.
  const remainingSpending = v.spending - v.amount;
  if (v.amount > v.spending) {
    rules.push({
      rule: "spending_budget",
      status: "fail",
      severity: "hard",
      message:
        `The payment of ${formatAtoms(v.amount)} USDC exceeds the ${formatAtoms(v.spending)} USDC spending ` +
        `allocation by ${formatAtoms(v.amount - v.spending)} USDC.`,
    });
  } else {
    rules.push({
      rule: "spending_budget",
      status: "pass",
      severity: "soft",
      message: `The payment fits the spending allocation, leaving ${formatAtoms(remainingSpending)} USDC.`,
    });
  }

  // Rule 3: the per-payment limit. A missing limit is not a pass.
  if (v.maxPayment === null) {
    rules.push({
      rule: "per_payment_limit",
      status: "unknown",
      severity: "soft",
      message:
        "No maximum individual payment limit was supplied, so this payment cannot be checked against one. " +
        "Supply maxPaymentUsdc to clear this check.",
    });
  } else if (v.amount > v.maxPayment) {
    rules.push({
      rule: "per_payment_limit",
      status: "fail",
      severity: "hard",
      message: `The payment of ${formatAtoms(v.amount)} USDC exceeds the per-payment limit of ${formatAtoms(v.maxPayment)} USDC.`,
    });
  } else {
    rules.push({
      rule: "per_payment_limit",
      status: "pass",
      severity: "soft",
      message: `The payment is within the per-payment limit of ${formatAtoms(v.maxPayment)} USDC.`,
    });
  }

  // Rule 4: the emergency reserve floor must survive the payment.
  const reserveAfter = v.available - v.amount;
  const floorLabel = v.reserveFloorFromOverride
    ? "the minimum emergency reserve you supplied"
    : "the emergency reserve allocation";
  if (reserveAfter < v.reserveFloor) {
    rules.push({
      rule: "emergency_reserve",
      status: "fail",
      severity: "hard",
      message:
        `Paying ${formatAtoms(v.amount)} USDC would leave ${formatAtoms(reserveAfter < 0n ? 0n : reserveAfter)} USDC, ` +
        `below ${floorLabel} of ${formatAtoms(v.reserveFloor)} USDC.`,
    });
  } else {
    rules.push({
      rule: "emergency_reserve",
      status: "pass",
      severity: "soft",
      message: `The payment leaves ${formatAtoms(reserveAfter)} USDC, at or above ${floorLabel} of ${formatAtoms(v.reserveFloor)} USDC.`,
    });
  }

  // Rule 5: preliminary recipient validation, only when one was supplied.
  if (input.recipient !== undefined && input.recipient !== null && input.recipient !== "") {
    const recipient = validateRecipient(input.recipient);
    if (!recipient.ok) {
      rules.push({
        rule: "recipient_address",
        status: "fail",
        severity: "hard",
        message: `The recipient address is unusable: ${recipient.error}`,
      });
    } else {
      rules.push({
        rule: "recipient_address",
        status: "pass",
        severity: "soft",
        message:
          recipient.checksum === "verified"
            ? "The recipient address is well formed and its EIP-55 checksum verifies."
            : "The recipient address is well formed. No EIP-55 checksum was present to verify.",
      });
    }
  }

  const blockedBy = rules.filter((r) => r.status === "fail" && r.severity === "hard").map((r) => r.rule);
  const reviewReasons = rules.filter((r) => r.status === "unknown" || (r.status === "fail" && r.severity === "soft")).map((r) => r.rule);

  const decision: PolicyDecision = blockedBy.length > 0 ? "blocked" : reviewReasons.length > 0 ? "review_required" : "allowed";

  const result: PolicyResult = {
    decision,
    paymentAmountUsdc: formatAtoms(v.amount),
    spendingAllocationUsdc: formatAtoms(v.spending),
    remainingSpendingUsdc: formatAtoms(remainingSpending < 0n ? 0n : remainingSpending),
    availableUsdc: formatAtoms(v.available),
    reserveFloorUsdc: formatAtoms(v.reserveFloor),
    reserveAfterPaymentUsdc: formatAtoms(reserveAfter < 0n ? 0n : reserveAfter),
    rules,
    blockedBy,
    reviewReasons,
    explanation: "",
  };

  result.explanation = renderPolicyExplanation(result);
  return { ok: true, result };
}

function renderPolicyExplanation(result: PolicyResult): string {
  const lines: string[] = [];
  if (result.decision === "allowed") {
    lines.push(`Decision: allowed. A ${result.paymentAmountUsdc} USDC payment passes every policy rule supplied.`);
  } else if (result.decision === "blocked") {
    lines.push(`Decision: blocked. A ${result.paymentAmountUsdc} USDC payment breaks a hard rule.`);
  } else {
    lines.push(
      `Decision: review_required. A ${result.paymentAmountUsdc} USDC payment is not clearly within policy: ` +
        "some required information is missing or the figures conflict.",
    );
  }
  for (const rule of result.rules) {
    const marker = rule.status === "pass" ? "OK" : rule.status === "fail" ? "FAIL" : "UNKNOWN";
    lines.push(`- [${marker}] ${rule.rule}: ${rule.message}`);
  }
  lines.push(`Spending allocation remaining after this payment: ${result.remainingSpendingUsdc} USDC.`);
  lines.push(
    "This is StablePilot's own review of the figures you supplied. It is not a PayBox-enforced limit, and PayBox authorizes payments separately.",
  );
  return lines.join("\n");
}
