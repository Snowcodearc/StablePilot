// StablePilot entry point.
//
// A standard MCP server over stdio, built on the official PayBox plugin starter
// toolchain. Registration does no network I/O and reads nothing from disk, so
// tool discovery is instant and side-effect free — which matters because the
// hosted preflight runs this module and can retry it.
//
// Four tools, in the order an agent should use them:
//   1. plan_stablecoin_allocation  — turn figures into a spending/savings/reserve plan
//   2. check_payment_policy        — test one payment against the user's own rules
//   3. propose_usdc_payment        — prepare an unsigned Base USDC proposal for PayBox
//   4. get_allocation_report       — explain an allocation in plain language

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { planAllocation } from "./allocation.js";
import { checkPolicy } from "./policy.js";
import { buildAllocationReport, proposeUsdcPayment } from "./payments.js";
import { evmOutputSchema } from "./paybox.js";
import {
  allocationReportInputSchema,
  allocationReportOutputSchema,
  checkPolicyInputSchema,
  checkPolicyOutputSchema,
  planAllocationInputSchema,
  planAllocationOutputSchema,
  proposePaymentInputSchema,
} from "./schemas.js";

/** The MCP revision this plugin speaks, as required by starter release 1.0.2. */
export const PROTOCOL_VERSION = "2026-07-28";

export const SERVER_INFO = { name: "stablepilot", version: "1.0.0" } as const;

export const TOOL_NAMES = [
  "plan_stablecoin_allocation",
  "check_payment_policy",
  "propose_usdc_payment",
  "get_allocation_report",
] as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

// A proposal tool is not read-only and is not idempotent: each call prepares a
// fresh, short-lived proposal. It reaches no network itself; the open-world hint
// reflects that PayBox will broadcast the transaction once the user approves it.
const PROPOSAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function text(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  // -------------------------------------------------------------------------
  // 1. plan_stablecoin_allocation
  // -------------------------------------------------------------------------
  server.registerTool(
    "plan_stablecoin_allocation",
    {
      title: "Plan a stablecoin allocation",
      description:
        "Divide a total USDC amount into spending, savings and emergency reserve allocations from figures the user supplies. " +
        "Returns the amount and percentage for each category, the unallocated remainder, and whether a savings goal is met. " +
        "It performs no wallet lookup, holds no funds and moves no money. " +
        "Use this first when a user states how they want to split their stablecoin holdings; then use check_payment_policy to test a specific payment.",
      inputSchema: planAllocationInputSchema,
      outputSchema: planAllocationOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ totalUsdc, spendingUsdc, savingsUsdc, emergencyReserveUsdc, savingsGoalUsdc, explain }) => {
      const outcome = planAllocation({
        totalUsdc,
        spendingUsdc,
        savingsUsdc,
        emergencyReserveUsdc,
        savingsGoalUsdc,
      });

      if (!outcome.ok) {
        return {
          isError: true,
          content: [text(`StablePilot could not build that plan. ${outcome.error}`)],
        };
      }

      const plan = outcome.plan;
      const oneLine =
        `Planned ${plan.totalUsdc} USDC: ${plan.spendingUsdc} spending, ${plan.savingsUsdc} savings, ` +
        `${plan.emergencyReserveUsdc} reserve, ${plan.unallocatedUsdc} unallocated.`;

      return {
        content: [text(explain === false ? oneLine : plan.explanation)],
        structuredContent: {
          status: "planned" as const,
          plan,
          ...(explain === false ? {} : { explanation: plan.explanation }),
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // 2. check_payment_policy
  // -------------------------------------------------------------------------
  server.registerTool(
    "check_payment_policy",
    {
      title: "Check a payment against allocation rules",
      description:
        "Test a proposed payment amount against the user's own allocation rules: does it fit the spending allocation, is it within a " +
        "maximum individual payment limit, and does it leave the emergency reserve intact. Returns allowed, blocked or review_required, " +
        "plus the remaining spending budget and an explanation of every failed rule. " +
        "This is StablePilot's own review of the figures passed in, not a PayBox-enforced limit and not a check of a real wallet balance. " +
        "Call it before propose_usdc_payment to explain a refusal, or on its own to answer 'can I afford this?'.",
      inputSchema: checkPolicyInputSchema,
      outputSchema: checkPolicyOutputSchema,
      annotations: READ_ONLY,
    },
    async ({
      availableUsdc,
      spendingAllocationUsdc,
      emergencyReserveUsdc,
      paymentAmountUsdc,
      maxPaymentUsdc,
      minEmergencyReserveUsdc,
      recipient,
    }) => {
      const outcome = checkPolicy({
        availableUsdc,
        spendingAllocationUsdc,
        emergencyReserveUsdc,
        paymentAmountUsdc,
        maxPaymentUsdc,
        minEmergencyReserveUsdc,
        recipient,
      });

      if (!outcome.ok) {
        return {
          isError: true,
          content: [text(`StablePilot could not evaluate that payment. ${outcome.error}`)],
        };
      }

      const result = outcome.result;
      return {
        content: [text(result.explanation)],
        structuredContent: {
          status: "checked" as const,
          decision: result.decision,
          result,
          explanation: result.explanation,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // 3. propose_usdc_payment
  // -------------------------------------------------------------------------
  server.registerTool(
    "propose_usdc_payment",
    {
      title: "Prepare an unsigned Base USDC payment proposal",
      description:
        "Prepare an unsigned PayBox transaction proposal for an ERC-20 USDC transfer on Base mainnet. Validates the recipient address and " +
        "the decimal amount, converts the amount to exact USDC atomic units, runs the payment policy checks, and only then builds the " +
        "io.paybox/transactionProposal object for PayBox to review and the user to authorize. " +
        "It never signs, broadcasts or executes anything, never handles private keys, and picks no wallet. " +
        "If any policy rule blocks the payment, no proposal is returned. Use it only after the user has stated their allocation and limits.",
      inputSchema: proposePaymentInputSchema,
      outputSchema: evmOutputSchema,
      annotations: PROPOSAL,
    },
    async ({
      chain,
      recipient,
      amountUsdc,
      availableUsdc,
      spendingAllocationUsdc,
      emergencyReserveUsdc,
      maxPaymentUsdc,
      minEmergencyReserveUsdc,
    }) => {
      const outcome = proposeUsdcPayment({
        chain,
        recipient,
        amountUsdc,
        availableUsdc,
        spendingAllocationUsdc,
        emergencyReserveUsdc,
        maxPaymentUsdc,
        minEmergencyReserveUsdc,
      });

      if (!outcome.ok) {
        // No proposal is returned on a refusal, and a refusal is an error
        // result, never a proposal.
        const lines = [outcome.error];
        if (outcome.policy) lines.push(outcome.policy.explanation);
        return { isError: true, content: [text(lines.join("\n"))] };
      }

      // PayBox builds and simulates the transaction; this plugin only prepares
      // the unsigned envelope. The wording deliberately attributes simulation to
      // PayBox and states what the guide states: a proposal is not a receipt,
      // and an ERC-20 transfer leaves the network fee to the user's wallet.
      const prepared =
        `Unsigned proposal prepared for ${amountUsdc} USDC to ${recipient} on ${chain} (${outcome.proposal.chain}). ` +
        `Native value is zero and the calldata is an ERC-20 transfer to the official USDC contract. ` +
        `Expires ${outcome.proposal.expiresAt}. PayBox selects the wallet, simulates the call, and the user authorizes the transfer. ` +
        `A proposal is not a receipt: returning it transfers no funds and does not guarantee that the simulation or the transfer will succeed. ` +
        `The wallet still needs a little ETH on Base to pay the network fee, which StablePilot does not estimate or cover.`;

      // The PayBox envelope is returned exactly as the official helper built it;
      // only an extra human-readable content block is prepended.
      return {
        content: [text(prepared), ...outcome.result.content],
        structuredContent: outcome.result.structuredContent,
      };
    },
  );

  // -------------------------------------------------------------------------
  // 4. get_allocation_report
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_allocation_report",
    {
      title: "Explain an allocation in plain language",
      description:
        "Produce a plain-language report of a USDC allocation for someone new to stablecoins: what each category is for, the amounts and " +
        "percentages, what is unallocated, what a proposed payment would do to the spending budget, any inconsistency found, and the " +
        "sensible next step. " +
        "Use it to explain a plan rather than to check a payment's compliance; check_payment_policy does the latter. " +
        "It promises no yield and no returns.",
      inputSchema: allocationReportInputSchema,
      outputSchema: allocationReportOutputSchema,
      annotations: READ_ONLY,
    },
    async ({ totalUsdc, spendingUsdc, savingsUsdc, emergencyReserveUsdc, proposedPaymentUsdc, savingsGoalUsdc }) => {
      const outcome = buildAllocationReport({
        totalUsdc,
        spendingUsdc,
        savingsUsdc,
        emergencyReserveUsdc,
        proposedPaymentUsdc,
        savingsGoalUsdc,
      });

      if (!outcome.ok) {
        return {
          isError: true,
          content: [text(`StablePilot could not build that report. ${outcome.error}`)],
        };
      }

      return {
        content: [text(outcome.report.explanation)],
        structuredContent: {
          status: "reported" as const,
          report: outcome.report,
          explanation: outcome.report.explanation,
        },
      };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
