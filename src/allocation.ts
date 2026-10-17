// Feature A: stablecoin allocation planner.
//
// This module is pure: same input, same output, no I/O, no clock, no globals.
// Everything is computed in atomic units and only rendered to decimals at the
// edges.

import { formatAtoms, formatPercent, parseAmount } from "./money.js";

export interface AllocationInput {
  totalUsdc: string;
  spendingUsdc: string;
  savingsUsdc: string;
  emergencyReserveUsdc: string;
  savingsGoalUsdc?: string;
}

export interface AllocationPercentages {
  spending: string;
  savings: string;
  emergencyReserve: string;
  allocated: string;
  unallocated: string;
}

export interface SavingsGoalVerdict {
  provided: boolean;
  targetUsdc: string | null;
  meetsGoal: boolean | null;
  shortfallUsdc: string | null;
}

export interface AllocationPlan {
  totalUsdc: string;
  spendingUsdc: string;
  savingsUsdc: string;
  emergencyReserveUsdc: string;
  totalAllocatedUsdc: string;
  unallocatedUsdc: string;
  percentages: AllocationPercentages;
  savingsGoal: SavingsGoalVerdict;
  notes: string[];
  explanation: string;
}

export type AllocationOutcome =
  | { ok: true; plan: AllocationPlan }
  | { ok: false; error: string; field: string };

type ParsedField = { ok: true; atoms: bigint } | { ok: false; error: string; field: string };

function parseField(value: string, label: string, field: string): ParsedField {
  const parsed = parseAmount(value);
  if (!parsed.ok) return { ok: false, error: `Invalid ${label}: ${parsed.error}`, field };
  return { ok: true, atoms: parsed.atoms };
}

/** Build an allocation plan, or explain precisely why the input is unusable. */
export function planAllocation(input: AllocationInput): AllocationOutcome {
  const totalParsed = parseField(input.totalUsdc, "total available USDC", "totalUsdc");
  if (!totalParsed.ok) return totalParsed;
  const spendingParsed = parseField(input.spendingUsdc, "spending allocation", "spendingUsdc");
  if (!spendingParsed.ok) return spendingParsed;
  const savingsParsed = parseField(input.savingsUsdc, "savings allocation", "savingsUsdc");
  if (!savingsParsed.ok) return savingsParsed;
  const reserveParsed = parseField(input.emergencyReserveUsdc, "emergency reserve allocation", "emergencyReserveUsdc");
  if (!reserveParsed.ok) return reserveParsed;

  let goalAtoms = 0n;
  let goalProvided = false;
  if (input.savingsGoalUsdc !== undefined && input.savingsGoalUsdc !== null && input.savingsGoalUsdc !== "") {
    const parsedGoal = parseAmount(input.savingsGoalUsdc);
    if (!parsedGoal.ok) {
      return { ok: false, error: `Invalid savings goal: ${parsedGoal.error}`, field: "savingsGoalUsdc" };
    }
    goalAtoms = parsedGoal.atoms;
    goalProvided = true;
  }

  const total = totalParsed.atoms;
  const spendingAtoms = spendingParsed.atoms;
  const savingsAtoms = savingsParsed.atoms;
  const reserveAtoms = reserveParsed.atoms;
  if (total === 0n) {
    return {
      ok: false,
      error:
        "The total available USDC is zero, so there is nothing to allocate. " +
        "Supply the amount you actually hold before planning.",
      field: "totalUsdc",
    };
  }

  const allocated = spendingAtoms + savingsAtoms + reserveAtoms;
  if (allocated > total) {
    const over = allocated - total;
    return {
      ok: false,
      error:
        `The allocations total ${formatAtoms(allocated)} USDC, which is ` +
        `${formatAtoms(over)} USDC more than the ${formatAtoms(total)} USDC available. ` +
        "Reduce one or more allocations, or correct the total.",
      field: "spendingUsdc",
    };
  }

  const unallocated = total - allocated;
  const meetsGoal = goalProvided ? savingsAtoms >= goalAtoms : null;
  const shortfall = goalProvided && savingsAtoms < goalAtoms ? goalAtoms - savingsAtoms : null;

  const notes: string[] = [
    "These figures describe the amounts you supplied. StablePilot cannot see a wallet and has not verified any on-chain balance.",
  ];
  if (unallocated > 0n) {
    notes.push(`${formatAtoms(unallocated)} USDC is left unallocated. Assign it, or keep it as an unassigned buffer.`);
  }
  if (goalProvided) {
    notes.push(
      meetsGoal
        ? `Savings of ${formatAtoms(savingsAtoms)} USDC meet the ${formatAtoms(goalAtoms)} USDC goal.`
        : `Savings of ${formatAtoms(savingsAtoms)} USDC fall ${formatAtoms(shortfall ?? 0n)} USDC short of the ${formatAtoms(goalAtoms)} USDC goal.`,
    );
  }

  const plan: AllocationPlan = {
    totalUsdc: formatAtoms(total),
    spendingUsdc: formatAtoms(spendingAtoms),
    savingsUsdc: formatAtoms(savingsAtoms),
    emergencyReserveUsdc: formatAtoms(reserveAtoms),
    totalAllocatedUsdc: formatAtoms(allocated),
    unallocatedUsdc: formatAtoms(unallocated),
    percentages: {
      spending: formatPercent(spendingAtoms, total),
      savings: formatPercent(savingsAtoms, total),
      emergencyReserve: formatPercent(reserveAtoms, total),
      allocated: formatPercent(allocated, total),
      unallocated: formatPercent(unallocated, total),
    },
    savingsGoal: {
      provided: goalProvided,
      targetUsdc: goalProvided ? formatAtoms(goalAtoms) : null,
      meetsGoal,
      shortfallUsdc: shortfall === null ? null : formatAtoms(shortfall),
    },
    notes,
    explanation: "",
  };

  plan.explanation = renderExplanation(plan);
  return { ok: true, plan };
}

function renderExplanation(plan: AllocationPlan): string {
  const lines = [
    `Allocation plan for ${plan.totalUsdc} USDC:`,
    `- Spending: ${plan.spendingUsdc} USDC (${plan.percentages.spending}%)`,
    `- Savings: ${plan.savingsUsdc} USDC (${plan.percentages.savings}%)`,
    `- Emergency reserve: ${plan.emergencyReserveUsdc} USDC (${plan.percentages.emergencyReserve}%)`,
    `- Total allocated: ${plan.totalAllocatedUsdc} USDC (${plan.percentages.allocated}%)`,
    `- Unallocated: ${plan.unallocatedUsdc} USDC (${plan.percentages.unallocated}%)`,
  ];
  if (plan.savingsGoal.provided) {
    lines.push(
      plan.savingsGoal.meetsGoal
        ? `Savings goal of ${plan.savingsGoal.targetUsdc} USDC: met.`
        : `Savings goal of ${plan.savingsGoal.targetUsdc} USDC: short by ${plan.savingsGoal.shortfallUsdc} USDC.`,
    );
  }
  lines.push("These are your own figures, not a verified wallet balance.");
  return lines.join("\n");
}
