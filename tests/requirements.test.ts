// Requirement-gap tests: the parts of the official PayBox plugin developer
// guide (https://developer.paybox.sh/requirements.md) that are checkable
// locally against the domain layer, with the guide's own wording as the source.
//
// Two groups:
//   1. USDC amount conversion, anchored to the official `atomicAmount` helper.
//   2. The EVM proposal field contract and the fields/keys the guide forbids.
//
// The guide's line references in comments are to the plain-text document.
// Tests that need the built artifact live in tests/protocol.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { atomicAmount } from "../src/paybox.js";
import { parseAmount } from "../src/money.js";
import { BASE_CHAIN_ID, USDC_BASE_MAINNET, USDC_DECIMALS } from "../src/erc20.js";
import { proposeUsdcPayment } from "../src/payments.js";

const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

const POLICY = {
  chain: "base",
  availableUsdc: "100",
  spendingAllocationUsdc: "10",
  emergencyReserveUsdc: "20",
  maxPaymentUsdc: "5",
};

function propose(amountUsdc: string) {
  const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc });
  assert.equal(outcome.ok, true, `expected "${amountUsdc}" to produce a proposal`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome;
}

// ---------------------------------------------------------------------------
// 1. USDC amounts: six decimals, exact, via the official helper
// ---------------------------------------------------------------------------
//
// "USDC uses six decimals: `"1.25"` becomes `1250000` atomic units."
// "`atomicAmount("0.001", 6)` returns `"1000"` without floating-point rounding."

test("USDC on Base uses six decimals", () => {
  assert.equal(USDC_DECIMALS, 6);
  assert.equal(atomicAmount("1", USDC_DECIMALS), "1000000");
});

test("the official atomicAmount helper and StablePilot's parser agree exactly", () => {
  // The guide tells builders to convert with `atomicAmount(amount, 6)`. This
  // plugin converts with its own decimal-safe parser, so the two must produce
  // identical atomic units for every amount the input schema admits.
  const amounts = [
    "0",
    "1",
    "1.25",
    "0.001",
    "0.000001",
    "10",
    "100",
    "1234567.891011",
    "0.1",
    "999999999999.999999",
    "5",
    "0.5",
  ];

  for (const amount of amounts) {
    const official = atomicAmount(amount, USDC_DECIMALS);
    const parsed = parseAmount(amount);
    assert.equal(parsed.ok, true, `StablePilot should accept "${amount}"`);
    if (!parsed.ok) continue;
    assert.equal(
      parsed.atoms.toString(),
      official,
      `atomic units for "${amount}" must match the official helper`,
    );
  }
});

test("the guide's own worked examples hold", () => {
  assert.equal(atomicAmount("1.25", 6), "1250000");
  assert.equal(atomicAmount("0.001", 6), "1000");

  const parsed = parseAmount("1.25");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.atoms, 1250000n);
});

test("an amount with more precision than USDC supports is refused by both", () => {
  // The input schema allows at most six decimals, so seven must not reach the
  // encoder. Checked at both layers.
  assert.throws(() => atomicAmount("0.0000001", USDC_DECIMALS), /more decimal places/);
  const parsed = parseAmount("0.0000001");
  assert.equal(parsed.ok, false);
});

// ---------------------------------------------------------------------------
// 2. The EVM proposal field contract
// ---------------------------------------------------------------------------
//
// "EVM: `kind: "evm"`, canonical `chain: "eip155:<chain ID>"`, and
//  `transaction: {to, value, data}`. `to` is a 20-byte hex address, `value` is
//  unsigned decimal wei, `data` is even-length hex calldata. One call only."

test("the USDC contract address is the deployed Base mainnet contract", () => {
  // The guide's worked USDC example uses this exact address.
  assert.equal(USDC_BASE_MAINNET.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
});

test("the envelope uses the canonical chain identifier", () => {
  assert.equal(BASE_CHAIN_ID, 8453);
  const { proposal } = propose("5");
  assert.equal(proposal.chain, `eip155:${BASE_CHAIN_ID}`);
  assert.equal(proposal.chain, "eip155:8453");
});

test("the transaction block has the documented field forms and one call only", () => {
  const { proposal } = propose("5");
  const transaction = proposal.transaction;

  assert.equal(proposal.version, "1");
  assert.equal(proposal.kind, "evm");

  // to: a 20-byte hex address, and the USDC contract for the chain.
  assert.match(transaction.to, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(transaction.to, USDC_BASE_MAINNET);

  // value: unsigned decimal wei. Not hex-prefixed, not negative, no exponent.
  assert.match(transaction.value, /^(0|[1-9][0-9]*)$/);
  assert.equal(transaction.value, "0", "an ERC-20 transfer moves no native currency");

  // data: even-length hex calldata.
  assert.match(transaction.data, /^0x(?:[0-9a-f]{2})*$/);
  assert.equal((transaction.data.length - 2) % 2, 0);

  // One call only: exactly the documented keys, nothing that could express a
  // second call or a batch.
  assert.deepEqual(Object.keys(transaction).sort(), ["data", "to", "value"]);
});

test("the expiry is whole-second UTC RFC3339 within the documented five minutes", () => {
  const before = Date.now();
  const { proposal } = propose("5");

  // Whole-second precision: no fractional part before the Z.
  assert.match(proposal.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const expires = Date.parse(proposal.expiresAt);
  assert.ok(Number.isFinite(expires));
  assert.ok(expires > before, "the proposal must not already be expired");
  assert.ok(expires <= before + 300_000, "expiresAt must be within five minutes");
  // The helper's default is four minutes; it must not silently grow.
  assert.ok(expires <= before + 240_000 + 1000, "the helper default is a four-minute expiry");
});

// ---------------------------------------------------------------------------
// 3. Fields and keys the guide forbids
// ---------------------------------------------------------------------------

function collectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      collectKeys(entry, found);
    }
  }
  return found;
}

test("no forbidden key appears anywhere in the proposal", () => {
  const { proposal } = propose("5");
  const keys = collectKeys(proposal);

  // "Do not include wallet IDs, signing keys, approval modes, signatures, RPC
  //  URLs or broadcast instructions in the proposal."
  const forbidden = [
    "walletId", "wallet_id", "wallet", "privateKey", "private_key", "signingKey", "secretKey",
    "mnemonic", "seedPhrase", "approvalMode", "approval_mode", "signature", "signatures",
    "signedTransaction", "rpcUrl", "rpc_url", "rpc", "broadcast", "broadcastInstruction",
    "submit", "send", "nonce", "chainId",
    // "There is no token, transfer or swap field in the proposal."
    "token", "transfer", "swap", "amount", "asset", "recipient",
    // No fee or gas field exists in the documented contract.
    "gas", "gasLimit", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "fee", "fees",
    "feeEstimate", "slippage", "valueWei",
  ];

  for (const key of forbidden) {
    assert.equal(keys.has(key), false, `proposal must not contain a "${key}" key`);
  }

  // Only the five documented top-level keys, and the recipient/amount live in
  // the calldata rather than as named fields.
  assert.deepEqual(
    Object.keys(proposal).sort(),
    ["chain", "expiresAt", "kind", "transaction", "version"],
  );
});

test("no forbidden value appears anywhere in the serialized proposal", () => {
  const { proposal } = propose("5");
  const serialized = JSON.stringify(proposal).toLowerCase();

  for (const needle of [
    "0x000000000000000000000000000000000000dEaD".toLowerCase(), // recipient is encoded, not named
    "priv", "mnemonic", "signature", "0x0x", "rpc", "broadcast", "nan", "infinity", "1e",
  ]) {
    assert.equal(serialized.includes(needle), false, `proposal must not contain "${needle}"`);
  }
});

test("the recipient and amount are recoverable from the calldata alone", () => {
  // The guide notes the transaction window shows raw details and does not
  // decode an ERC-20 transfer, so the calldata is the authoritative record.
  const { proposal } = propose("5");
  const data = proposal.transaction.data;

  assert.equal(data.slice(0, 10), "0xa9059cbb");
  assert.equal(data.slice(10, 74), RECIPIENT.toLowerCase().replace(/^0x/, "").padStart(64, "0"));
  assert.equal(BigInt(`0x${data.slice(74)}`), 5_000_000n, "5 USDC in six-decimal atomic units");
});

test("a refusal produces no envelope to inspect", () => {
  // Guide: "Do not put a proposal in an `isError` result." The plugin achieves
  // that by not building one at all on any refusal path.
  const refusals: ReadonlyArray<Partial<Parameters<typeof proposeUsdcPayment>[0]>> = [
    { amountUsdc: "15" }, // over the spending allocation, and over the per-payment limit
    { amountUsdc: "0" }, // not a positive amount
    { recipient: "0x1234" }, // malformed recipient
    { chain: "eip155:1" as unknown as "base" }, // unsupported chain
    { amountUsdc: "1.0000001" }, // more precision than USDC supports
  ];

  for (const override of refusals) {
    const outcome = proposeUsdcPayment({ ...POLICY, recipient: RECIPIENT, amountUsdc: "5", ...override });
    assert.equal(outcome.ok, false, `expected a refusal for ${JSON.stringify(override)}`);
    if (outcome.ok) continue;
    assert.equal("proposal" in outcome, false);
    assert.equal("result" in outcome, false);
  }
});
