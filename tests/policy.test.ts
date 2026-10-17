// Feature B tests: the payment policy checker.

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkPolicy } from "../src/policy.js";

const BASE = {
  availableUsdc: "100",
  spendingAllocationUsdc: "10",
  emergencyReserveUsdc: "20",
  maxPaymentUsdc: "5",
};

test("a payment inside the spending limit and the per-payment limit is allowed", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "5" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "allowed");
  assert.equal(outcome.result.blockedBy.length, 0);
  assert.equal(outcome.result.reviewReasons.length, 0);
  assert.equal(outcome.result.remainingSpendingUsdc, "5");
});

test("a payment equal to the permitted limit is allowed", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "5", maxPaymentUsdc: "5" });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.result.decision, "allowed");
});

test("a payment equal to the whole spending allocation is allowed", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "10", maxPaymentUsdc: "10" });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.decision, "allowed");
    assert.equal(outcome.result.remainingSpendingUsdc, "0");
  }
});

test("a payment above the spending limit is blocked and explains the gap", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "15" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "blocked");
  // 15 USDC breaks two hard rules at once: it exceeds the 10 USDC spending
  // allocation and the 5 USDC per-payment limit. Both must be reported.
  assert.deepEqual(outcome.result.blockedBy, ["spending_budget", "per_payment_limit"]);
  const rule = outcome.result.rules.find((r) => r.rule === "spending_budget");
  assert.ok(rule);
  assert.match(rule.message, /exceeds the 10 USDC spending allocation by 5 USDC/);
  assert.equal(outcome.result.remainingSpendingUsdc, "0");
});

test("a payment over the spending limit that is inside the per-payment limit reports one violation", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "15", maxPaymentUsdc: "50" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "blocked");
  assert.deepEqual(outcome.result.blockedBy, ["spending_budget"]);
});

test("a payment above the per-transaction maximum is blocked", () => {
  const outcome = checkPolicy({
    ...BASE,
    spendingAllocationUsdc: "100",
    paymentAmountUsdc: "7",
    maxPaymentUsdc: "5",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "blocked");
  assert.deepEqual(outcome.result.blockedBy, ["per_payment_limit"]);
  const rule = outcome.result.rules.find((r) => r.rule === "per_payment_limit");
  assert.ok(rule);
  assert.match(rule.message, /exceeds the per-payment limit of 5 USDC/);
});

test("a payment that would breach the emergency reserve is blocked", () => {
  const outcome = checkPolicy({
    availableUsdc: "100",
    spendingAllocationUsdc: "60",
    emergencyReserveUsdc: "20",
    paymentAmountUsdc: "60",
    maxPaymentUsdc: "100",
    minEmergencyReserveUsdc: "50",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "blocked");
  assert.deepEqual(outcome.result.blockedBy, ["emergency_reserve"]);
  const rule = outcome.result.rules.find((r) => r.rule === "emergency_reserve");
  assert.ok(rule);
  assert.match(rule.message, /would leave 40 USDC, below the minimum emergency reserve you supplied of 50 USDC/);
  assert.equal(outcome.result.reserveAfterPaymentUsdc, "40");
});

test("the emergency reserve allocation is the floor when no explicit minimum is given", () => {
  const outcome = checkPolicy({
    availableUsdc: "100",
    spendingAllocationUsdc: "60",
    emergencyReserveUsdc: "40",
    paymentAmountUsdc: "60",
    maxPaymentUsdc: "100",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // A payment that fits a consistent spending allocation cannot eat the
  // reserve, because the reserve was never part of the spending budget.
  assert.equal(outcome.result.decision, "allowed");
  assert.equal(outcome.result.reserveFloorUsdc, "40");
  assert.equal(outcome.result.reserveAfterPaymentUsdc, "40");
});

test("an explicit minimum emergency reserve overrides the reserve allocation", () => {
  const outcome = checkPolicy({
    availableUsdc: "100",
    spendingAllocationUsdc: "60",
    emergencyReserveUsdc: "20",
    paymentAmountUsdc: "60",
    maxPaymentUsdc: "100",
    minEmergencyReserveUsdc: "40",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "allowed");
  assert.equal(outcome.result.reserveFloorUsdc, "40");
  assert.equal(outcome.result.reserveAfterPaymentUsdc, "40");
  const rule = outcome.result.rules.find((r) => r.rule === "emergency_reserve");
  assert.ok(rule);
  assert.match(rule.message, /minimum emergency reserve you supplied/);
});

test("missing policy inputs produce review_required, never allowed", () => {
  const outcome = checkPolicy({
    availableUsdc: "100",
    spendingAllocationUsdc: "10",
    emergencyReserveUsdc: "20",
    paymentAmountUsdc: "5",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "review_required");
  assert.deepEqual(outcome.result.reviewReasons, ["per_payment_limit"]);
  assert.match(outcome.result.rules.find((r) => r.rule === "per_payment_limit")!.message, /No maximum individual payment limit/);
});

test("contradictory allocations produce review_required", () => {
  const outcome = checkPolicy({
    availableUsdc: "50",
    spendingAllocationUsdc: "40",
    emergencyReserveUsdc: "20",
    paymentAmountUsdc: "1",
    maxPaymentUsdc: "5",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.decision, "review_required");
  assert.deepEqual(outcome.result.reviewReasons, ["allocation_consistency"]);
});

test("a zero payment amount is rejected as an input error", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "0" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error, /must be greater than zero/);
    assert.equal(outcome.field, "paymentAmountUsdc");
  }
});

test("a malformed recipient address is blocked, and a checksummed one passes", () => {
  const bad = checkPolicy({ ...BASE, paymentAmountUsdc: "1", recipient: "0xnot-an-address" });
  assert.equal(bad.ok, true);
  if (bad.ok) {
    assert.equal(bad.result.decision, "blocked");
    assert.deepEqual(bad.result.blockedBy, ["recipient_address"]);
  }

  const good = checkPolicy({
    ...BASE,
    paymentAmountUsdc: "1",
    recipient: "0x000000000000000000000000000000000000dEaD",
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.result.decision, "allowed");
    assert.match(good.result.rules.find((r) => r.rule === "recipient_address")!.message, /EIP-55 checksum verifies/);
  }
});

test("invalid numeric policy inputs are rejected with the offending field", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "1.2345678" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.field, "paymentAmountUsdc");
});

test("a policy failure never reports remaining budget as negative", () => {
  const outcome = checkPolicy({ ...BASE, paymentAmountUsdc: "50" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.remainingSpendingUsdc, "0");
});
