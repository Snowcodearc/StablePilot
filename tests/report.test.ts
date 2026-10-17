// Feature D tests: the plain-language allocation report.
//
// The report is a user-facing behaviour the brief calls out explicitly, so it
// gets direct assertions rather than being covered only incidentally. The
// tool-level behaviour of the same feature is exercised over real MCP stdio in
// tests/protocol.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAllocationReport } from "../src/payments.js";

const PLAN = {
  totalUsdc: "100",
  spendingUsdc: "10",
  savingsUsdc: "70",
  emergencyReserveUsdc: "20",
};

test("a report restates the allocation in plain language", () => {
  const outcome = buildAllocationReport(PLAN);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const { report } = outcome;
  assert.equal(report.totalUsdc, "100");
  assert.equal(report.allocations.spendingUsdc, "10");
  assert.equal(report.allocations.savingsUsdc, "70");
  assert.equal(report.allocations.emergencyReserveUsdc, "20");
  assert.equal(report.percentages.spending, "10.00");
  assert.equal(report.unallocatedUsdc, "0");
  assert.deepEqual(report.inconsistencies, []);
  assert.equal(report.proposedPayment.provided, false);
  assert.equal(report.proposedPayment.amountUsdc, null);
  assert.match(report.explanation, /money you plan to pay out/);
  assert.match(report.explanation, /does not earn yield/);
});

test("a report explains the impact of a proposed payment that fits", () => {
  const outcome = buildAllocationReport({ ...PLAN, proposedPaymentUsdc: "5" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const { proposedPayment, inconsistencies } = outcome.report;
  assert.equal(proposedPayment.provided, true);
  assert.equal(proposedPayment.amountUsdc, "5");
  assert.equal(proposedPayment.fitsSpending, true);
  assert.equal(proposedPayment.breachesReserve, false);
  assert.equal(proposedPayment.remainingSpendingUsdc, "5");
  assert.deepEqual(inconsistencies, []);
  assert.ok(outcome.report.nextSteps.some((step) => step.includes("check_payment_policy")));
});

test("a report detects a payment larger than the spending allocation", () => {
  const outcome = buildAllocationReport({ ...PLAN, proposedPaymentUsdc: "25" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.report.proposedPayment.fitsSpending, false);
  assert.equal(outcome.report.proposedPayment.remainingSpendingUsdc, "0");
  assert.equal(outcome.report.inconsistencies.length, 1);
  const [inconsistency] = outcome.report.inconsistencies;
  assert.ok(inconsistency, "the mismatch should be reported once");
  assert.match(inconsistency, /25 USDC payment is larger than the 10 USDC spending allocation/);
  assert.ok(outcome.report.nextSteps.some((step) => step.includes("Reduce the payment to at most 10 USDC")));
});

test("a report detects a payment that would breach the emergency reserve", () => {
  // The plan itself must add up (80 + 0 + 20 = 100) before the reserve check is
  // meaningful. An 85 USDC payment then exceeds the spending allocation and
  // drops the balance below the 20 USDC reserve at the same time.
  const outcome = buildAllocationReport({
    totalUsdc: "100",
    spendingUsdc: "80",
    savingsUsdc: "0",
    emergencyReserveUsdc: "20",
    proposedPaymentUsdc: "85",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.report.proposedPayment.breachesReserve, true);
  assert.equal(outcome.report.proposedPayment.fitsSpending, false);
  assert.ok(outcome.report.inconsistencies.some((line) => line.includes("would leave less than the 20 USDC emergency reserve")));
  assert.ok(outcome.report.inconsistencies.some((line) => line.includes("larger than the 80 USDC spending allocation")));
});

test("a report flags unallocated funds and a missed savings goal as next steps", () => {
  const outcome = buildAllocationReport({
    totalUsdc: "100",
    spendingUsdc: "10",
    savingsUsdc: "50",
    emergencyReserveUsdc: "20",
    savingsGoalUsdc: "80",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.report.unallocatedUsdc, "20");
  assert.ok(outcome.report.nextSteps.some((step) => step.includes("20 USDC that is not yet allocated")));
  assert.ok(outcome.report.nextSteps.some((step) => step.includes("short by 30 USDC")));
  assert.ok(outcome.report.nextSteps.some((step) => step.includes("network fees")));
});

test("a report rejects the same invalid allocations the planner rejects", () => {
  const outcome = buildAllocationReport({ ...PLAN, spendingUsdc: "500" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.field, "spendingUsdc");
  assert.match(outcome.error, /590 USDC/);
  assert.match(outcome.error, /490 USDC more than the 100 USDC available/);
});

test("a report rejects a malformed proposed payment", () => {
  const outcome = buildAllocationReport({ ...PLAN, proposedPaymentUsdc: "1.2345678" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.field, "proposedPaymentUsdc");
});
