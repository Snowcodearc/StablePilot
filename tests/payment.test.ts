// Feature C tests: amount conversion, address validation, calldata, the
// official PayBox proposal envelope, and the rule that a rejected payment never
// produces a transaction proposal.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bytesToHex, keccak256, utf8 } from "../src/keccak.js";
import { formatAtoms, formatPercent, parseAmount } from "../src/money.js";
import { toChecksumAddress, validateRecipient } from "../src/validation.js";
import {
  BASE_CHAIN,
  ERC20_TRANSFER_SELECTOR,
  USDC_BASE_MAINNET,
  assertEvmProposalInvariants,
  encodeErc20Transfer,
  proposalExpiry,
  resolveChain,
  usdcContractFor,
} from "../src/erc20.js";
import { proposeUsdcPayment } from "../src/payments.js";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const PAYBOX_KEY = "io.paybox/transactionProposal";

const POLICY = {
  chain: "base",
  availableUsdc: "100",
  spendingAllocationUsdc: "10",
  emergencyReserveUsdc: "20",
  maxPaymentUsdc: "5",
};

// --- Keccak-256 known-answer tests -----------------------------------------

test("keccak256 matches the published test vectors", () => {
  assert.equal(
    bytesToHex(keccak256(utf8(""))),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.equal(
    bytesToHex(keccak256(utf8("abc"))),
    "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
  // Longer than one 136-byte absorb block, exercising the multi-block path.
  // Cross-checked against js-sha3 0.9.3 on 313 inputs (single- and multi-block
  // lengths plus 300 random byte arrays) when this implementation was written.
  assert.equal(
    bytesToHex(keccak256(utf8("a".repeat(200)))),
    "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d",
  );
  assert.equal(
    bytesToHex(keccak256(utf8("a".repeat(136)))),
    "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e",
  );
  assert.equal(
    bytesToHex(keccak256(utf8("a".repeat(135)))),
    "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446",
  );
});

test("the ERC-20 transfer selector is derived correctly", () => {
  assert.equal(ERC20_TRANSFER_SELECTOR, "0xa9059cbb");
});

// --- Amount conversion ------------------------------------------------------

test("decimal USDC converts to exact atomic units", () => {
  const cases: ReadonlyArray<{ input: string; atoms: string }> = [
    { input: "1.25", atoms: "1250000" },
    { input: "100", atoms: "100000000" },
    { input: "0.000001", atoms: "1" },
    { input: "0.1", atoms: "100000" },
    { input: "5", atoms: "5000000" },
    { input: "0", atoms: "0" },
    { input: "1234567.891011", atoms: "1234567891011" },
  ];

  for (const { input, atoms } of cases) {
    const parsed = parseAmount(input);
    assert.equal(parsed.ok, true, `expected "${input}" to parse`);
    if (parsed.ok) assert.equal(parsed.atoms.toString(), atoms, `atomic units for "${input}"`);
  }
});

test("atomic units render back to canonical decimal strings", () => {
  assert.equal(formatAtoms(1250000n), "1.25");
  assert.equal(formatAtoms(1n), "0.000001");
  assert.equal(formatAtoms(0n), "0");
  assert.equal(formatAtoms(100000000n), "100");
  assert.equal(formatAtoms(100000n), "0.1");
});

test("percentages round to two decimals without floating point", () => {
  assert.equal(formatPercent(10n, 100n), "10.00");
  assert.equal(formatPercent(1n, 3n), "33.33");
  assert.equal(formatPercent(2n, 3n), "66.67");
  assert.equal(formatPercent(1n, 0n), "0.00");
});

test("a zero amount is accepted at the amount layer", () => {
  const parsed = parseAmount("0");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.atoms, 0n);
});

test("a negative amount and an over-precise amount are rejected", () => {
  const negative = parseAmount("-1");
  assert.equal(negative.ok, false);
  if (!negative.ok) assert.match(negative.error, /negative/);

  const precise = parseAmount("0.0000001");
  assert.equal(precise.ok, false);
  if (!precise.ok) assert.match(precise.error, /at most 6/);
});

// --- Address validation -----------------------------------------------------

test("EIP-55 checksums are computed correctly", () => {
  assert.equal(toChecksumAddress(VITALIK.toLowerCase()), VITALIK);
  assert.equal(toChecksumAddress(USDC_BASE_MAINNET.toLowerCase()), USDC_BASE_MAINNET);
});

test("the Base USDC contract address is checksum-valid and well known", () => {
  assert.equal(USDC_BASE_MAINNET, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(toChecksumAddress(USDC_BASE_MAINNET), USDC_BASE_MAINNET);
  assert.equal(USDC_BASE_MAINNET.length, 42);
});

test("a valid recipient is accepted in lowercase and in checksummed form", () => {
  const lower = validateRecipient(RECIPIENT.toLowerCase());
  assert.equal(lower.ok, true);
  if (lower.ok) {
    assert.equal(lower.checksum, "not-applicable");
    assert.equal(lower.address, RECIPIENT);
  }

  const checksummed = validateRecipient(RECIPIENT);
  assert.equal(checksummed.ok, true);
  if (checksummed.ok) assert.equal(checksummed.checksum, "verified");
});

test("invalid recipients are rejected with a specific reason", () => {
  const cases: ReadonlyArray<{ value: string; expected: RegExp }> = [
    { value: "", expected: /required/ },
    { value: "not-an-address", expected: /must start with "0x"/ },
    { value: "0x1234", expected: /has 4 hex characters/ },
    { value: "0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", expected: /not hexadecimal/ },
    { value: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96044", expected: /EIP-55 checksum/ },
  ];

  for (const { value, expected } of cases) {
    const result = validateRecipient(value);
    assert.equal(result.ok, false, `expected "${value}" to be rejected`);
    if (!result.ok) assert.match(result.error, expected);
  }
});

test("a checksum failure suggests the correct address", () => {
  const result = validateRecipient("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96044");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /0xd8dA6Bf26964AF9D7eed9e03e53415D37AA96044/);
});

// --- Chain and contract resolution -----------------------------------------

test("only Base mainnet is supported, under both accepted selectors", () => {
  const base = resolveChain("base");
  assert.equal(base.ok, true);
  if (base.ok) {
    assert.equal(base.canonical, BASE_CHAIN);
    assert.equal(base.chainId, 8453);
  }

  const caip = resolveChain("eip155:8453");
  assert.equal(caip.ok, true);
  if (caip.ok) assert.equal(caip.canonical, BASE_CHAIN);

  for (const unsupported of ["mainnet", "ethereum", "eip155:1", "solana", ""]) {
    assert.equal(resolveChain(unsupported).ok, false, `expected "${unsupported}" to be rejected`);
  }
});

test("the USDC contract is resolved per chain and never reused across chains", () => {
  assert.equal(usdcContractFor("eip155:8453"), USDC_BASE_MAINNET);
  assert.equal(usdcContractFor("eip155:1"), null);
  assert.equal(usdcContractFor("solana:mainnet"), null);
});

// --- Calldata ---------------------------------------------------------------

test("ERC-20 transfer calldata is selector plus two left-padded 32-byte words", () => {
  const data = encodeErc20Transfer(RECIPIENT, 1250000n);
  assert.equal(data.length, 10 + 64 + 64);
  assert.equal(data.slice(0, 10), "0xa9059cbb");
  assert.equal(
    data.slice(10, 74),
    "000000000000000000000000000000000000000000000000000000000000dead",
  );
  assert.equal(
    data.slice(74),
    "00000000000000000000000000000000000000000000000000000000001312d0",
  );
  assert.equal(
    data,
    "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead" +
      "00000000000000000000000000000000000000000000000000000000001312d0",
  );
});

test("a mixed-case recipient is lowercased into the calldata", () => {
  const data = encodeErc20Transfer(VITALIK, 1n);
  assert.equal(data.slice(10, 74), VITALIK.toLowerCase().replace(/^0x/, "").padStart(64, "0"));
});

// --- Proposal construction --------------------------------------------------

test("a valid request produces the official PayBox EVM proposal envelope", () => {
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: "5" });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const { proposal, result } = outcome;

  // The envelope carries exactly the five fields PayBox documents for an EVM
  // proposal, and nothing else: unknown fields are rejected by PayBox.
  assert.deepEqual(Object.keys(proposal).sort(), ["chain", "expiresAt", "kind", "transaction", "version"]);
  assert.equal(proposal.version, "1");
  assert.equal(proposal.kind, "evm");
  assert.equal(proposal.chain, "eip155:8453");
  assert.match(proposal.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.deepEqual(Object.keys(proposal.transaction).sort(), ["data", "to", "value"]);
  assert.equal(proposal.transaction.to, USDC_BASE_MAINNET);
  assert.equal(proposal.transaction.value, "0", "an ERC-20 transfer sends no native value");
  assert.equal(proposal.transaction.data, encodeErc20Transfer(RECIPIENT, 5000000n));

  // No hand-built fields from earlier drafts may survive.
  for (const gone of ["type", "schemaVersion", "asset", "requiresUserApproval", "summary"]) {
    assert.equal(gone in proposal, false, `proposal must not carry a "${gone}" field`);
  }

  // The result exposes the proposal under the documented structuredContent key,
  // and nothing beside it.
  assert.deepEqual(Object.keys(result.structuredContent), [PAYBOX_KEY]);
  assert.equal(result.content.length, 1);
  const [summary] = result.content;
  assert.ok(summary, "the result should carry one summary item");
  assert.match(summary.text, /Unsigned proposal prepared/);

  assert.doesNotThrow(() => assertEvmProposalInvariants(proposal));
});

test("the proposal expiry is a whole-second UTC timestamp within five minutes", () => {
  const before = Date.now();
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: "5" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const expires = Date.parse(outcome.proposal.expiresAt);
  assert.ok(Number.isFinite(expires), "expiry must parse");
  assert.ok(expires > before, "expiry must be in the future");
  assert.ok(expires <= Date.now() + 300_000, "expiry must be within five minutes");
  assert.equal(
    new Date(expires).toISOString().replace(/\.\d{3}Z$/, "Z"),
    outcome.proposal.expiresAt,
    "expiry must have whole-second precision and a Z suffix",
  );
});

test("the expiry helper is deterministic and uses the four-minute default", () => {
  assert.equal(proposalExpiry(new Date("2026-01-01T00:00:00.000Z")), "2026-01-01T00:04:00Z");
  assert.equal(proposalExpiry(new Date("2026-01-01T23:59:30.500Z")), "2026-01-02T00:03:30Z");
});

test("the proposal carries no signing material or wallet selection", () => {
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: "5" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const serialized = JSON.stringify(outcome.proposal).toLowerCase();
  for (const forbidden of ["privatekey", "private_key", "mnemonic", "seed", "signature", "signed", "walletid", "wallet_id", "rpc"]) {
    assert.equal(serialized.includes(forbidden), false, `proposal must not contain "${forbidden}"`);
  }
});

test("proposal invariants catch a tampered proposal", () => {
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: "5" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const proposal = outcome.proposal;
  assert.doesNotThrow(() => assertEvmProposalInvariants(proposal));

  const badTarget = { ...proposal, transaction: { ...proposal.transaction, to: RECIPIENT } };
  assert.throws(() => assertEvmProposalInvariants(badTarget), /not the USDC contract/);

  const badValue = { ...proposal, transaction: { ...proposal.transaction, value: "1" } };
  assert.throws(() => assertEvmProposalInvariants(badValue), /native value must be zero/);

  const badData = { ...proposal, transaction: { ...proposal.transaction, data: "0xdeadbeef" } };
  assert.throws(() => assertEvmProposalInvariants(badData), /ERC-20 transfer selector/);

  const zeroAmount = {
    ...proposal,
    transaction: { ...proposal.transaction, data: encodeErc20Transfer(RECIPIENT, 0n) },
  };
  assert.throws(() => assertEvmProposalInvariants(zeroAmount), /encoded amount must be positive/);
});

test("invariants reject a proposal on an unsupported chain", () => {
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: "5" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const wrongChain = { ...outcome.proposal, chain: "eip155:1" };
  assert.throws(() => assertEvmProposalInvariants(wrongChain), /unresolvable chain/);
});

// --- A rejected payment never yields a proposal -----------------------------

test("a payment above the spending allocation is blocked and builds no proposal", () => {
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: "15" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, "policy");
  assert.equal(outcome.policy?.decision, "blocked");
  assert.equal("proposal" in outcome, false);
  assert.equal("result" in outcome, false);
});

test("a payment above the per-payment limit is blocked and builds no proposal", () => {
  const outcome = proposeUsdcPayment({
    ...POLICY,
    spendingAllocationUsdc: "100",
    recipient: RECIPIENT,
    amountUsdc: "9",
    maxPaymentUsdc: "5",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.policy?.blockedBy.includes("per_payment_limit"), true);
});

test("a payment that breaches the emergency reserve floor is blocked and builds no proposal", () => {
  const outcome = proposeUsdcPayment({
    ...POLICY,
    spendingAllocationUsdc: "60",
    maxPaymentUsdc: "100",
    minEmergencyReserveUsdc: "50",
    recipient: RECIPIENT,
    amountUsdc: "60",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.policy?.blockedBy.includes("emergency_reserve"), true);
});

test("a payment with no per-payment limit requires review and builds no proposal", () => {
  const outcome = proposeUsdcPayment({
    chain: "base",
    recipient: RECIPIENT,
    amountUsdc: "5",
    availableUsdc: "100",
    spendingAllocationUsdc: "10",
    emergencyReserveUsdc: "20",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.policy?.decision, "review_required");
});

test("a zero, negative or over-precise amount is rejected before any proposal", () => {
  const cases: ReadonlyArray<{ amount: string; expected: RegExp }> = [
    { amount: "0", expected: /greater than zero/ },
    { amount: "-1", expected: /negative/ },
    { amount: "1.0000001", expected: /at most 6/ },
  ];

  for (const { amount, expected } of cases) {
    const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: amount });
    assert.equal(outcome.ok, false, `expected amount "${amount}" to be rejected`);
    if (outcome.ok) continue;
    assert.equal(outcome.stage, "validation");
    assert.match(outcome.error, expected);
  }
});

test("an invalid recipient is rejected before any proposal", () => {
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: "0x1234", amountUsdc: "5" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, "validation");
  assert.equal(outcome.field, "recipient");
});

test("an unsupported chain is rejected before any proposal", () => {
  const outcome = proposeUsdcPayment({ ...POLICY, chain: "eip155:1", recipient: RECIPIENT, amountUsdc: "5" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.field, "chain");
  assert.match(outcome.error, /Base mainnet only/);
});

test("the same request always produces the same proposal for the same clock", () => {
  const now = new Date();
  const request = { ...POLICY, recipient: RECIPIENT, amountUsdc: "5" };
  assert.deepEqual(proposeUsdcPayment(request, now), proposeUsdcPayment(request, now));
});
