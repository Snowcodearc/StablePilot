// Feature C: USDC payment proposal, and Feature D: allocation report.
//
// Both compose the pure modules above them. The payment path is intentionally
// ordered so that no proposal can be constructed unless validation, the policy
// checks and the calldata invariants all pass first. The proposal envelope
// itself comes from the official PayBox helpers, never from hand-built JSON.

import { formatAtoms, parseAmount } from "./money.js";
import type { PolicyResult } from "./policy.js";
import { checkPolicy } from "./policy.js";
import {
  BASE_CHAIN,
  assertEvmProposalInvariants,
  encodeErc20Transfer,
  proposalExpiry,
  resolveChain,
  usdcContractFor,
} from "./erc20.js";
import { proposeEvm } from "./paybox.js";
import { planAllocation, type AllocationPlan } from "./allocation.js";
import { validateRecipient } from "./validation.js";

/** Exactly what `proposeEvm` returns, including the text content block. */
export type ProposalToolResult = ReturnType<typeof proposeEvm>;

/** The `io.paybox/transactionProposal` value inside that result. */
export type PreparedProposal = ProposalToolResult["structuredContent"]["io.paybox/transactionProposal"];

export interface PaymentRequest {
  chain: string;
  recipient: string;
  amountUsdc: string;
  availableUsdc: string;
  spendingAllocationUsdc: string;
  emergencyReserveUsdc: string;
  maxPaymentUsdc?: string;
  minEmergencyReserveUsdc?: string;
}

export type PaymentOutcome =
  | { ok: true; result: ProposalToolResult; proposal: PreparedProposal; policy: PolicyResult }
  | { ok: false; stage: "validation" | "policy"; error: string; field?: string; policy: PolicyResult | null };

/** Validate, policy-check and then build an unsigned USDC transfer proposal. */
export function proposeUsdcPayment(input: PaymentRequest, now: Date = new Date()): PaymentOutcome {
  const chain = resolveChain(input.chain);
  if (!chain.ok) return { ok: false, stage: "validation", error: chain.error, field: "chain", policy: null };

  if (usdcContractFor(chain.canonical) === null) {
    return {
      ok: false,
      stage: "validation",
      error: `No USDC contract is configured for ${chain.canonical}.`,
      field: "chain",
      policy: null,
    };
  }

  const recipient = validateRecipient(input.recipient);
  if (!recipient.ok) return { ok: false, stage: "validation", error: recipient.error, field: "recipient", policy: null };

  const amount = parseAmount(input.amountUsdc);
  if (!amount.ok) {
    return { ok: false, stage: "validation", error: `Invalid payment amount: ${amount.error}`, field: "amountUsdc", policy: null };
  }
  if (amount.atoms === 0n) {
    return {
      ok: false,
      stage: "validation",
      error: "The payment amount must be greater than zero. StablePilot does not build proposals for zero-value transfers.",
      field: "amountUsdc",
      policy: null,
    };
  }

  const policy = checkPolicy({
    availableUsdc: input.availableUsdc,
    spendingAllocationUsdc: input.spendingAllocationUsdc,
    emergencyReserveUsdc: input.emergencyReserveUsdc,
    paymentAmountUsdc: input.amountUsdc,
    maxPaymentUsdc: input.maxPaymentUsdc,
    minEmergencyReserveUsdc: input.minEmergencyReserveUsdc,
    recipient: input.recipient,
  });

  if (!policy.ok) {
    return { ok: false, stage: "validation", error: policy.error, field: policy.field, policy: null };
  }
  if (policy.result.decision !== "allowed") {
    return {
      ok: false,
      stage: "policy",
      error:
        policy.result.decision === "blocked"
          ? "This payment is blocked by your policy rules, so no transaction proposal was built."
          : "This payment needs review before a proposal can be built.",
      policy: policy.result,
    };
  }

  // One EVM call: native value is zero and the calldata is the ERC-20 transfer
  // to the official Base USDC contract. PayBox supplies the wallet, simulation
  // and signing, so no wallet or fee information belongs in this proposal.
  const result = proposeEvm({
    chain: BASE_CHAIN,
    to: usdcContractFor(chain.canonical) ?? "",
    value: "0",
    data: encodeErc20Transfer(recipient.address, amount.atoms),
    expiresAt: proposalExpiry(now),
  });

  const proposal = result.structuredContent["io.paybox/transactionProposal"];
  assertEvmProposalInvariants(proposal);

  return { ok: true, result, proposal, policy: policy.result };
}

// ---------------------------------------------------------------------------
// Feature D: allocation report
// ---------------------------------------------------------------------------

export interface ReportRequest {
  totalUsdc: string;
  spendingUsdc: string;
  savingsUsdc: string;
  emergencyReserveUsdc: string;
  proposedPaymentUsdc?: string;
  savingsGoalUsdc?: string;
}

export interface AllocationReport {
  totalUsdc: string;
  allocations: {
    spendingUsdc: string;
    savingsUsdc: string;
    emergencyReserveUsdc: string;
  };
  percentages: {
    spending: string;
    savings: string;
    emergencyReserve: string;
    unallocated: string;
  };
  unallocatedUsdc: string;
  proposedPayment: {
    provided: boolean;
    amountUsdc: string | null;
    fitsSpending: boolean | null;
    remainingSpendingUsdc: string | null;
    breachesReserve: boolean | null;
  };
  inconsistencies: string[];
  nextSteps: string[];
  explanation: string;
}

export type ReportOutcome = { ok: true; report: AllocationReport } | { ok: false; error: string; field: string };

/** Produce a plain-language allocation report, optionally with a payment impact. */
export function buildAllocationReport(input: ReportRequest): ReportOutcome {
  const planned = planAllocation({
    totalUsdc: input.totalUsdc,
    spendingUsdc: input.spendingUsdc,
    savingsUsdc: input.savingsUsdc,
    emergencyReserveUsdc: input.emergencyReserveUsdc,
    savingsGoalUsdc: input.savingsGoalUsdc,
  });
  if (!planned.ok) return { ok: false, error: planned.error, field: planned.field };

  const plan: AllocationPlan = planned.plan;
  const inconsistencies: string[] = [];
  const nextSteps: string[] = [];

  let provided = false;
  let amountUsdc: string | null = null;
  let fitsSpending: boolean | null = null;
  let remainingSpending: string | null = null;
  let breachesReserve: boolean | null = null;

  const spendingAtoms = parseAmount(plan.spendingUsdc);
  const reserveAtoms = parseAmount(plan.emergencyReserveUsdc);
  const totalAtoms = parseAmount(plan.totalUsdc);
  if (!spendingAtoms.ok || !reserveAtoms.ok || !totalAtoms.ok) {
    return { ok: false, error: "Internal allocation figures could not be re-parsed.", field: "totalUsdc" };
  }

  if (input.proposedPaymentUsdc !== undefined && input.proposedPaymentUsdc !== null && input.proposedPaymentUsdc !== "") {
    const payment = parseAmount(input.proposedPaymentUsdc);
    if (!payment.ok) return { ok: false, error: `Invalid proposed payment: ${payment.error}`, field: "proposedPaymentUsdc" };

    provided = true;
    amountUsdc = formatAtoms(payment.atoms);
    fitsSpending = payment.atoms <= spendingAtoms.atoms;
    remainingSpending = formatAtoms(
      spendingAtoms.atoms - payment.atoms > 0n ? spendingAtoms.atoms - payment.atoms : 0n,
    );
    breachesReserve = totalAtoms.atoms - payment.atoms < reserveAtoms.atoms;

    if (!fitsSpending) {
      inconsistencies.push(
        `The proposed ${amountUsdc} USDC payment is larger than the ${plan.spendingUsdc} USDC spending allocation.`,
      );
      nextSteps.push(
        `Reduce the payment to at most ${plan.spendingUsdc} USDC, or raise the spending allocation in your plan.`,
      );
    }
    if (breachesReserve) {
      inconsistencies.push(
        `The proposed payment would leave less than the ${plan.emergencyReserveUsdc} USDC emergency reserve.`,
      );
      nextSteps.push("Lower the payment amount, or accept a smaller emergency reserve before proceeding.");
    }
    if (fitsSpending && !breachesReserve) {
      nextSteps.push(
        "The payment fits your plan. Next, check it against your limits with check_payment_policy, then prepare it with propose_usdc_payment.",
      );
    }
  }

  if (plan.unallocatedUsdc !== "0") {
    nextSteps.push(`Decide what to do with the ${plan.unallocatedUsdc} USDC that is not yet allocated.`);
  }
  if (plan.savingsGoal.provided && plan.savingsGoal.meetsGoal === false) {
    nextSteps.push(`Your savings goal is short by ${plan.savingsGoal.shortfallUsdc} USDC.`);
  }
  nextSteps.push("Confirm the real balance in your own wallet, and remember that network fees are charged separately.");

  const report: AllocationReport = {
    totalUsdc: plan.totalUsdc,
    allocations: {
      spendingUsdc: plan.spendingUsdc,
      savingsUsdc: plan.savingsUsdc,
      emergencyReserveUsdc: plan.emergencyReserveUsdc,
    },
    percentages: {
      spending: plan.percentages.spending,
      savings: plan.percentages.savings,
      emergencyReserve: plan.percentages.emergencyReserve,
      unallocated: plan.percentages.unallocated,
    },
    unallocatedUsdc: plan.unallocatedUsdc,
    proposedPayment: { provided, amountUsdc, fitsSpending, remainingSpendingUsdc: remainingSpending, breachesReserve },
    inconsistencies,
    nextSteps,
    explanation: "",
  };

  report.explanation = renderReport(report, plan);
  return { ok: true, report };
}

function renderReport(report: AllocationReport, plan: AllocationPlan): string {
  const lines = [
    `You are dividing ${report.totalUsdc} USDC like this:`,
    `- Spending: ${report.allocations.spendingUsdc} USDC (${report.percentages.spending}%) - money you plan to pay out.`,
    `- Savings: ${report.allocations.savingsUsdc} USDC (${report.percentages.savings}%) - money you intend to keep.`,
    `- Emergency reserve: ${report.allocations.emergencyReserveUsdc} USDC (${report.percentages.emergencyReserve}%) - money you do not want to touch.`,
    `- Not yet allocated: ${report.unallocatedUsdc} USDC (${report.percentages.unallocated}%).`,
  ];
  if (report.proposedPayment.provided) {
    lines.push(
      `A payment of ${report.proposedPayment.amountUsdc} USDC would leave ` +
        `${report.proposedPayment.remainingSpendingUsdc} USDC of spending budget.`,
    );
  }
  lines.push(...plan.notes.map((note) => `Note: ${note}`));
  lines.push("StablePilot is an allocation and payment assistant. It does not earn yield and promises no returns.");
  return lines.join("\n");
}
