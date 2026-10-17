// Zod schemas for every StablePilot tool, in one place.
//
// `plugin.ts` registers tools from these, and the tests reuse them to validate
// real tool output, so the advertised contract and the checked contract cannot
// drift apart.
//
// Input schemas parse the same decimal grammar `money.ts` enforces (at most six
// decimal places, no sign, no scientific notation, no leading zeros), so the
// schema rejects malformed input before the domain layer has to explain it.

import * as z from "zod/v4";

const USDC_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const usdcAmount = (description: string) =>
  z.string().regex(USDC_AMOUNT_PATTERN).describe(`${description} Decimal USDC as a string, e.g. "10" or "10.25".`);

const evmAddress = z
  .string()
  .regex(EVM_ADDRESS_PATTERN)
  .describe("EVM address. Mixed-case addresses must carry a valid EIP-55 checksum.");

const chainSelector = z
  .enum(["base", "eip155:8453"])
  .describe('Chain to pay on. Base mainnet only: "base" or "eip155:8453".');

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const planAllocationInputSchema = z
  .object({
    totalUsdc: usdcAmount("Total USDC the user says they have available."),
    spendingUsdc: usdcAmount("How much of the total to earmark for spending."),
    savingsUsdc: usdcAmount("How much of the total to earmark for savings."),
    emergencyReserveUsdc: usdcAmount("How much of the total to hold back as an emergency reserve."),
    savingsGoalUsdc: usdcAmount("Optional savings target to check the savings allocation against.").optional(),
    explain: z.boolean().describe("Set false for the structured plan and a one-line summary only.").optional(),
  })
  .strict();

export const checkPolicyInputSchema = z
  .object({
    availableUsdc: usdcAmount("Total USDC the user says they have available."),
    spendingAllocationUsdc: usdcAmount("The spending allocation from the user's plan."),
    emergencyReserveUsdc: usdcAmount("The emergency reserve from the user's plan."),
    paymentAmountUsdc: usdcAmount("The payment being tested."),
    maxPaymentUsdc: usdcAmount("Optional maximum allowed for a single payment.").optional(),
    minEmergencyReserveUsdc: usdcAmount(
      "Optional explicit floor for the emergency reserve, overriding the reserve allocation.",
    ).optional(),
    recipient: evmAddress.optional(),
  })
  .strict();

export const proposePaymentInputSchema = z
  .object({
    chain: chainSelector,
    recipient: evmAddress,
    amountUsdc: usdcAmount("Amount to transfer, in USDC."),
    availableUsdc: usdcAmount("Total USDC the user says they have available."),
    spendingAllocationUsdc: usdcAmount("The spending allocation for this period."),
    emergencyReserveUsdc: usdcAmount("The emergency reserve that must survive the payment."),
    maxPaymentUsdc: usdcAmount(
      "Maximum allowed for a single payment. Without it the payment cannot be cleared automatically.",
    ).optional(),
    minEmergencyReserveUsdc: usdcAmount(
      "Optional explicit emergency reserve floor, overriding the reserve allocation.",
    ).optional(),
  })
  .strict();

export const allocationReportInputSchema = z
  .object({
    totalUsdc: usdcAmount("Total USDC the user says they have available."),
    spendingUsdc: usdcAmount("The spending allocation."),
    savingsUsdc: usdcAmount("The savings allocation."),
    emergencyReserveUsdc: usdcAmount("The emergency reserve allocation."),
    proposedPaymentUsdc: usdcAmount("Optional payment to show the impact of.").optional(),
    savingsGoalUsdc: usdcAmount("Optional savings target.").optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const percentagesSchema = z
  .object({
    spending: z.string(),
    savings: z.string(),
    emergencyReserve: z.string(),
    allocated: z.string(),
    unallocated: z.string(),
  })
  .strict();

const savingsGoalSchema = z
  .object({
    provided: z.boolean(),
    targetUsdc: z.string().nullable(),
    meetsGoal: z.boolean().nullable(),
    shortfallUsdc: z.string().nullable(),
  })
  .strict();

export const allocationPlanSchema = z
  .object({
    totalUsdc: z.string(),
    spendingUsdc: z.string(),
    savingsUsdc: z.string(),
    emergencyReserveUsdc: z.string(),
    totalAllocatedUsdc: z.string(),
    unallocatedUsdc: z.string(),
    percentages: percentagesSchema,
    savingsGoal: savingsGoalSchema,
    notes: z.array(z.string()),
    explanation: z.string(),
  })
  .strict();

export const planAllocationOutputSchema = z
  .object({
    status: z.enum(["planned", "error"]),
    error: z.string().optional(),
    plan: allocationPlanSchema.optional(),
    explanation: z.string().optional(),
  })
  .strict();

const policyRuleSchema = z
  .object({
    rule: z.string(),
    status: z.enum(["pass", "fail", "unknown"]),
    severity: z.enum(["hard", "soft"]),
    message: z.string(),
  })
  .strict();

export const policyResultSchema = z
  .object({
    decision: z.enum(["allowed", "blocked", "review_required"]),
    paymentAmountUsdc: z.string(),
    spendingAllocationUsdc: z.string(),
    remainingSpendingUsdc: z.string(),
    availableUsdc: z.string(),
    reserveFloorUsdc: z.string(),
    reserveAfterPaymentUsdc: z.string(),
    rules: z.array(policyRuleSchema),
    blockedBy: z.array(z.string()),
    reviewReasons: z.array(z.string()),
    explanation: z.string(),
  })
  .strict();

export const checkPolicyOutputSchema = z
  .object({
    status: z.enum(["checked", "error"]),
    error: z.string().optional(),
    decision: z.enum(["allowed", "blocked", "review_required"]).optional(),
    result: policyResultSchema.optional(),
    explanation: z.string().optional(),
  })
  .strict();

export const allocationReportSchema = z
  .object({
    totalUsdc: z.string(),
    allocations: z
      .object({
        spendingUsdc: z.string(),
        savingsUsdc: z.string(),
        emergencyReserveUsdc: z.string(),
      })
      .strict(),
    percentages: z
      .object({
        spending: z.string(),
        savings: z.string(),
        emergencyReserve: z.string(),
        unallocated: z.string(),
      })
      .strict(),
    unallocatedUsdc: z.string(),
    proposedPayment: z
      .object({
        provided: z.boolean(),
        amountUsdc: z.string().nullable(),
        fitsSpending: z.boolean().nullable(),
        remainingSpendingUsdc: z.string().nullable(),
        breachesReserve: z.boolean().nullable(),
      })
      .strict(),
    inconsistencies: z.array(z.string()),
    nextSteps: z.array(z.string()),
    explanation: z.string(),
  })
  .strict();

export const allocationReportOutputSchema = z
  .object({
    status: z.enum(["reported", "error"]),
    error: z.string().optional(),
    report: allocationReportSchema.optional(),
    explanation: z.string().optional(),
  })
  .strict();
