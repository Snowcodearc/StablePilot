// Feature A tests: the stablecoin allocation planner.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planAllocation } from "../src/allocation.js";

test("a valid 100 USDC allocation splits 10 / 70 / 20 with nothing unallocated", () => {
  const outcome = planAllocation({
    totalUsdc: "100",
    spendingUsdc: "10",
    savingsUsdc: "70",
    emergencyReserveUsdc: "20",
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const { plan } = outcome;
  assert.equal(plan.totalUsdc, "100");
  assert.equal(plan.spendingUsdc, "10");
  assert.equal(plan.savingsUsdc, "70");
  assert.equal(plan.emergencyReserveUsdc, "20");
  assert.equal(plan.totalAllocatedUsdc, "100");
  assert.equal(plan.unallocatedUsdc, "0");
  assert.equal(plan.percentages.spending, "10.00");
  assert.equal(plan.percentages.savings, "70.00");
  assert.equal(plan.percentages.emergencyReserve, "20.00");
  assert.equal(plan.percentages.allocated, "100.00");
  assert.equal(plan.percentages.unallocated, "0.00");
});

test("an allocation that does not use the whole balance reports the remainder", () => {
  const outcome = planAllocation({
    totalUsdc: "100",
    spendingUsdc: "60",
    savingsUsdc: "30",
    emergencyReserveUsdc: "5",
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.plan.totalAllocatedUsdc, "95");
  assert.equal(outcome.plan.unallocatedUsdc, "5");
  assert.equal(outcome.plan.percentages.allocated, "95.00");
  assert.equal(outcome.plan.percentages.unallocated, "5.00");
  assert.ok(outcome.plan.notes.some((note) => note.includes("5 USDC is left unallocated")));
});

test("an allocation exceeding the supplied total is rejected with the overshoot", () => {
  const outcome = planAllocation({
    totalUsdc: "100",
    spendingUsdc: "50",
    savingsUsdc: "40",
    emergencyReserveUsdc: "20",
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /110 USDC/);
  assert.match(outcome.error, /10 USDC more than the 100 USDC available/);
  assert.equal(outcome.field, "spendingUsdc");
});

test("negative amounts are rejected", () => {
  const outcome = planAllocation({
    totalUsdc: "100",
    spendingUsdc: "-10",
    savingsUsdc: "70",
    emergencyReserveUsdc: "20",
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /is negative/);
  assert.equal(outcome.field, "spendingUsdc");
});

test("invalid decimal values are rejected with a specific reason", () => {
  const cases: ReadonlyArray<{ value: string; expected: RegExp }> = [
    { value: "abc", expected: /not a valid decimal amount/ },
    { value: "1e6", expected: /scientific notation/ },
    { value: "1.2345678", expected: /at most 6/ },
    { value: "", expected: /required/ },
    { value: " 10", expected: /whitespace/ },
    { value: "007", expected: /leading zero/ },
  ];

  for (const { value, expected } of cases) {
    const outcome = planAllocation({
      totalUsdc: "100",
      spendingUsdc: value,
      savingsUsdc: "0",
      emergencyReserveUsdc: "0",
    });
    assert.equal(outcome.ok, false, `expected "${value}" to be rejected`);
    if (outcome.ok) continue;
    assert.match(outcome.error, expected);
  }
});

test("a zero available balance is rejected rather than producing an empty plan", () => {
  const outcome = planAllocation({
    totalUsdc: "0",
    spendingUsdc: "0",
    savingsUsdc: "0",
    emergencyReserveUsdc: "0",
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /total available USDC is zero/);
  assert.equal(outcome.field, "totalUsdc");
});

test("a savings goal is reported as met or short", () => {
  const met = planAllocation({
    totalUsdc: "100",
    spendingUsdc: "10",
    savingsUsdc: "70",
    emergencyReserveUsdc: "20",
    savingsGoalUsdc: "50",
  });
  assert.equal(met.ok, true);
  if (met.ok) {
    assert.equal(met.plan.savingsGoal.provided, true);
    assert.equal(met.plan.savingsGoal.meetsGoal, true);
    assert.equal(met.plan.savingsGoal.shortfallUsdc, null);
  }

  const short = planAllocation({
    totalUsdc: "100",
    spendingUsdc: "10",
    savingsUsdc: "70",
    emergencyReserveUsdc: "20",
    savingsGoalUsdc: "90",
  });
  assert.equal(short.ok, true);
  if (short.ok) {
    assert.equal(short.plan.savingsGoal.meetsGoal, false);
    assert.equal(short.plan.savingsGoal.shortfallUsdc, "20");
  }
});

test("amounts are exact at the smallest USDC unit", () => {
  const outcome = planAllocation({
    totalUsdc: "0.000003",
    spendingUsdc: "0.000001",
    savingsUsdc: "0.000001",
    emergencyReserveUsdc: "0.000001",
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.plan.unallocatedUsdc, "0");
  assert.equal(outcome.plan.spendingUsdc, "0.000001");
});

test("repeated calls with the same input give identical output", () => {
  const input = { totalUsdc: "100", spendingUsdc: "10", savingsUsdc: "70", emergencyReserveUsdc: "20" };
  assert.deepEqual(planAllocation(input), planAllocation(input));
});
