// Smart Split arithmetic: 30% spending, 50% savings, 20% emergency reserve.
//
// This module decides only how the *input* to the plugin is built. The plugin
// still owns the plan: it validates the amounts, computes the percentages and
// returns the figures the interface confirms. Everything here is integer
// micro-USDC arithmetic, so no floating point touches a balance and the three
// parts always reconcile to the exact amount entered.

import { USDC_AMOUNT, fromAtoms, money, toAtoms } from "./format.js";

/** The one tool this feature calls. Never rename or duplicate it. */
export const TOOL = "plan_stablecoin_allocation";

/** Defaults published by the product: they must total 100. */
export const SPLIT_PERCENT = Object.freeze({ spending: 30, savings: 50, reserve: 20 });

export const MIN_USDC = "100";

const MIN_ATOMS = toAtoms(MIN_USDC);

/** The labels and accent categories, in display order. */
export const CATEGORIES = Object.freeze([
  { key: "spending", name: "Spending", percent: SPLIT_PERCENT.spending, blurb: "Day-to-day spending" },
  { key: "savings", name: "Savings", percent: SPLIT_PERCENT.savings, blurb: "Kept as savings" },
  {
    key: "reserve",
    name: "Emergency reserve",
    percent: SPLIT_PERCENT.reserve,
    blurb: "Held back for emergencies",
  },
]);

const base = { ok: false, amounts: null, atoms: null };

/**
 * Validates an entered amount and splits it 30/50/20 in micro-USDC units.
 *
 * Returns `{ ok: true, atoms, amounts: {spending, savings, reserve} }` with
 * decimal strings, or `{ ok: false, error }` with a message for the field.
 * The user's text is never rewritten.
 */
export function splitAmount(input) {
  const text = String(input ?? "").trim();
  const invalid = (error) => ({ ...base, input: text, error });

  if (text === "") return invalid("Enter the amount you want to split.");
  if (/^[-−]/.test(text)) return invalid("Amount cannot be negative.");
  if (/,/.test(text)) return invalid("Use a plain decimal such as 1200.50, without commas.");
  if (!USDC_AMOUNT.test(text)) {
    return invalid("Enter a number with up to six decimal places, for example 250 or 1200.50.");
  }

  const atoms = toAtoms(text);
  if (atoms === null) return invalid("Enter a number with up to six decimal places.");
  if (atoms === 0n) return invalid(`Enter at least ${MIN_USDC} USDC.`);
  if (atoms < MIN_ATOMS) {
    return invalid(`The minimum is ${MIN_USDC} USDC. You entered ${money(text)} USDC.`);
  }

  // Floor the two published shares, then give the rounding remainder to the
  // reserve so spending + savings + reserve equals the entered amount exactly.
  const spending = (atoms * BigInt(SPLIT_PERCENT.spending)) / 100n;
  const savings = (atoms * BigInt(SPLIT_PERCENT.savings)) / 100n;
  const reserve = atoms - spending - savings;

  return {
    ok: true,
    input: text,
    atoms,
    amounts: {
      spending: fromAtoms(spending),
      savings: fromAtoms(savings),
      reserve: fromAtoms(reserve),
    },
    unallocated: "0",
    remainderAtoms: reserve - (atoms * BigInt(SPLIT_PERCENT.reserve)) / 100n,
  };
}

/**
 * The exact `tools/call` arguments for `plan_stablecoin_allocation`.
 * `totalUsdc` keeps the user's own text; the parts are the computed decimals.
 */
export function planPayload(split) {
  if (!split?.ok) throw new Error("Cannot build a payload from an invalid split.");
  return {
    totalUsdc: split.input,
    spendingUsdc: split.amounts.spending,
    savingsUsdc: split.amounts.savings,
    emergencyReserveUsdc: split.amounts.reserve,
    explain: true,
  };
}

/** A stable summary line for the activity log. */
export function activitySummary(split) {
  return `${money(split.input)} USDC split ${SPLIT_PERCENT.spending}/${SPLIT_PERCENT.savings}/${SPLIT_PERCENT.reserve}`;
}
