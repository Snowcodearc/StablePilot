# StablePilot

**Plan USDC allocations, check payment rules, and prepare controlled Base payments through PayBox.**

StablePilot is a [PayBox](https://paybox.sh) plugin: a standard TypeScript MCP server that helps a user
turn stablecoin goals into a structured allocation, evaluate a proposed payment against their own
rules, and — only when those rules pass — prepare an unsigned Base USDC transfer proposal for PayBox
to review and the user to authorize.

Its core promise:

> Plan your stablecoin finances. Stay within your limits. Let PayBox handle payment authorization.

StablePilot plans and proposes. It never signs, broadcasts, or executes anything, never touches a
private key, and never chooses a wallet.

It is built on the official PayBox plugin starter **v1.0.2** (protocol version `2026-07-28`), using
the starter's pinned toolchain and its official conformance tooling.

---

## 1. Why it exists

An agent with a wallet is powerful and slightly terrifying. The usual answer is a spending limit,
which is a single number and tells the user nothing about consequence. StablePilot takes the other
route: it makes the *plan* explicit and first-class, then judges every payment against that plan
before a transaction is ever constructed.

That gives three things a raw transfer tool does not:

- **A pre-flight answer in words.** "This 15 USDC payment exceeds your 10 USDC spending allocation
  by 5 USDC" is more useful to a human than a rejected transaction.
- **Refusals that produce nothing.** A payment that breaks a hard rule returns no proposal at all,
  so there is nothing to accidentally approve.
- **Exactness.** All money is integer atomic units. `1.25` USDC becomes `1250000`, exactly, with no
  floating-point step anywhere in the path.

## 2. What it is not

- Not a wallet, not a custodian, and not a signer.
- Not a replacement for PayBox's own authorization. PayBox enforces its own limits and approvals.
- Not a source of truth about a balance. Every figure a tool uses is supplied by the user or the
  agent. StablePilot cannot see a wallet balance and never claims to have verified one.
- Not an investment product. It promises no yield and no returns.

## 3. Tools

Four MCP tools. Each returns structured content plus a plain-language explanation.

| Tool | Use it for |
| --- | --- |
| `plan_stablecoin_allocation` | Split a total USDC amount into spending, savings and emergency reserve, with percentages, the unallocated remainder, and whether a savings goal is met. |
| `check_payment_policy` | Answer "can I afford this?" — test one payment against the spending allocation, a per-payment limit, and the emergency reserve. Returns `allowed`, `blocked` or `review_required`. |
| `propose_usdc_payment` | Validate a recipient and amount, run the policy checks, and only then build an unsigned `io.paybox/transactionProposal` for a Base USDC transfer. |
| `get_allocation_report` | Explain an allocation in plain language, including what a proposed payment would do to the spending budget. |

### Decision semantics

`check_payment_policy` and `propose_usdc_payment` return exactly three decisions:

- **`allowed`** — every supplied rule passed. A proposal may be built.
- **`blocked`** — a hard constraint failed (overspent allocation, per-payment limit, emergency
  reserve floor, unusable recipient). No proposal is built.
- **`review_required`** — something needed to judge the payment is missing or self-contradictory:
  no maximum payment limit was supplied, or the stated spending allocation plus reserve exceeds the
  stated balance. StablePilot refuses to guess.

A missing per-payment limit is deliberately **not** a pass. Without it the payment cannot be
cleared automatically.

### Emergency reserve semantics

The emergency reserve is a floor on the balance that must survive a payment. When the allocation is
internally consistent, a payment inside the spending budget cannot reach the reserve, because the
reserve was never part of the spending budget — the rule is structurally satisfied. The rule bites
in two cases: the caller supplies `minEmergencyReserveUsdc` higher than the planned reserve (an
explicit "never go below this" floor), or the stated balance is smaller than the plan assumed.

## 4. Installation and verification

Requires Node.js 24 and pnpm 11.11.0, as pinned by the starter.

```bash
pnpm install --frozen-lockfile
pnpm run build          # writes dist/plugin.mjs
pnpm test               # the official starter suite: typecheck, build x2 (byte-identical), conformance
```

`pnpm test` is the starter's own `scripts/test.mjs`. **On native Windows it stops with
`environment_invalid`**, because the official conformance runner only accepts macOS and Linux (the
PayBox hosted runtime is Linux). See [`LIMITATIONS.md`](./LIMITATIONS.md) §7.5 for what that does and
does not mean.

### The official result

The official conformance result is produced on a supported platform, with the Node version the
starter's CI pins:

```bash
# macOS, Linux or WSL2 — Node.js 24.21.0, pnpm 11.11.0
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` type-checks, builds twice, requires identical bytes, then runs conformance. For the JSON
report alone, with no other output:

```bash
pnpm --silent conformance
```

A pass prints `status: "passed"`, `artifact.bytes`, `artifact.sha256` and `discoveredToolCount`, and
exits 0.

**`pnpm run conformance:windows` is not the official result.** It is a development convenience that
lets the official assertions run on this Windows machine with only the operating-system gate
bypassed. Do not cite its output as conformance, and do not use it in place of the block above.

On this machine, the equivalent local verification is:

```bash
pnpm run verify
```

which runs, in order:

| Step | What it proves |
| --- | --- |
| `pnpm run verify:starter` | The files adopted from the official starter are the official 1.0.2 bytes, checked against the release's own SHA-256 manifest. |
| `pnpm run typecheck` | `src/` compiles under the starter's strict `NodeNext` config. |
| `pnpm run typecheck:tests` | The test suite typechecks against the same config. |
| `pnpm run test:unit` | 73 assertions over allocation, policy, money, the proposal contract and the official requirement gaps. |
| `pnpm run test:protocol` | 21 assertions that spawn the built `dist/plugin.mjs` and drive it over real MCP stdio. |
| `pnpm run build` | Produces `dist/plugin.mjs`. |
| `pnpm run conformance:windows` | Runs the **official** conformance assertions (see below). |

`pnpm run conformance` is the official report script. `pnpm run conformance:windows` is a thin local
wrapper: it imports the official `testArtifact()` **unchanged** and only reports `process.platform`
as `linux` so the host gate lets the official assertions run. Everything after the gate is the
official code path — artifact validation, `tools/list` paging, schema compilation, the
`paybox-plugin.json` sample call, and result validation. The report it prints states the real
platform and marks the gate as bypassed. It is not a substitute for running `pnpm test` on macOS,
Linux or WSL2.

Then point an MCP host at the built artifact:

```bash
node dist/plugin.mjs
```

The server speaks MCP over stdio (protocol version `2026-07-28`) and does no network I/O at startup,
so tool discovery is instant and offline.

### Configuration

`paybox-plugin.json` is exactly two fields — the tool to call and its arguments:

```json
{
  "tool": "plan_stablecoin_allocation",
  "arguments": {
    "totalUsdc": "100",
    "spendingUsdc": "10",
    "savingsUsdc": "70",
    "emergencyReserveUsdc": "20"
  }
}
```

The conformance run validates those arguments against the tool's advertised input schema and
executes them against the built artifact, then validates the result against its output schema.

### Host configuration example

```json
{
  "mcpServers": {
    "stablepilot": {
      "command": "node",
      "args": ["/absolute/path/to/dist/plugin.mjs"]
    }
  }
}
```

## 5. The payment path

`propose_usdc_payment` runs these steps in order, and stops at the first failure:

1. Validate the recipient: 20-byte hex, and if the address is mixed-case its EIP-55 checksum must
   verify. A checksum failure usually means a typo, which in a payment is the difference between
   paying the intended recipient and paying a stranger.
2. Parse the amount strictly: a plain decimal string, positive, at most 6 decimal places, no
   scientific notation, no leading zeros. Convert to atomic units.
3. Resolve the chain selector. Only Base mainnet (`base` / `eip155:8453`) is supported.
4. Resolve the USDC contract **for that chain**. The same symbol on another network is a different
   asset, so the address is keyed by the canonical chain id and never reused.
5. Run the policy checks. Anything other than `allowed` stops here and returns no proposal.
6. Build the ERC-20 calldata: `0xa9059cbb` + the recipient and amount as two left-padded 32-byte
   words. The selector is *derived* from Keccak-256 at runtime rather than hardcoded, and the test
   suite pins it to `0xa9059cbb`.
7. Set the native transaction value to `"0"` — an ERC-20 transfer sends no native currency.
8. Assemble the envelope with `version: "1"`, `kind: "evm"`, `chain: "eip155:8453"`, and a fresh
   short-lived expiry.
9. Run a structural self-check. If any invariant fails — wrong target, non-zero value, malformed
   calldata, zero amount, unresolvable chain — the plugin throws rather than emitting a proposal
   someone might approve.

Steps 1–8 use the starter's own helpers: `proposeEvm()` from `src/paybox.ts`, with the atomic amount
from `atomicAmount()`. StablePilot supplies the policy decision and the calldata; PayBox's helper
supplies the envelope shape and the expiry field. Nothing about the envelope is hand-rolled.

### Proposal shape

The proposal is returned as a property of `structuredContent`, under the documented key:

```json
{
  "io.paybox/transactionProposal": {
    "version": "1",
    "kind": "evm",
    "chain": "eip155:8453",
    "expiresAt": "2026-01-01T00:04:00Z",
    "transaction": {
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "value": "0",
      "data": "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000004c4b40"
    }
  }
}
```

Notes on the fields that matter:

- `expiresAt` is whole-second RFC3339 UTC, four minutes out (the starter default), derived from an
  injectable clock so it is deterministic under test.
- `value` is a decimal wei string, and is `"0"` because the transfer moves USDC, not ETH.
- `data` is even-length lowercase hex; the recipient and the amount are visible in it as two
  left-padded 32-byte words.
- There is **no** `type`, `schemaVersion`, `asset`, `requiresUserApproval` or `summary` field.
  PayBox rejects unknown fields, and a test asserts the envelope carries exactly these five keys.

## 6. Safety properties

- **No key material, ever.** The plugin does not request, read, store, or transmit private keys,
  seed phrases, wallet credentials, or signatures. A test asserts the built bundle contains none of
  the strings that would imply otherwise.
- **No signing or broadcasting.** There is no code path that signs or sends. A proposal is an
  intent, and §11 keeps the vocabulary honest about that.
- **No wallet choice.** No wallet id is hardcoded and none is chosen; PayBox handles selection.
- **No false success.** Building a proposal is never reported as a completed payment.
- **No hidden state.** PayBox may run each operation in a fresh process, so every tool takes the
  allocation and policy figures it needs as arguments and returns them in its output. Nothing is
  persisted to disk, memory, or a database, and nothing is reserved between calls.
- **No network.** No RPC endpoint, no price feed, no external API. The only runtime dependencies are
  the official `@modelcontextprotocol/server` and `zod`, both bundled into the artifact.

## 7. Precision

Money never touches a JavaScript `number`.

- Amounts are parsed from strings into `bigint` atomic units (`1 USDC = 1_000_000`).
- Percentages are computed in basis points with explicit half-up rounding.
- Comparisons are integer comparisons.
- `1.25` → `1250000`. `0.000001` → `1`. `1234567.891011` → `1234567891011`.

## 8. Testing

| Suite | Covers |
| --- | --- |
| `tests/allocation.test.ts` | The 100 USDC plan, unallocated funds, over-allocation, negatives, invalid decimals, zero balance, savings goals, smallest-unit exactness, determinism. |
| `tests/policy.test.ts` | Inside the limit, above the spending limit, above the per-payment maximum, equal to the limit, reserve breach, reserve floor override, missing limits, contradictory allocations, recipient validation. |
| `tests/payment.test.ts` | Keccak-256 known-answer vectors, the ERC-20 selector, decimal to atomic conversion, address validation and EIP-55 checksums, chain and contract resolution, exact calldata, the official proposal envelope (exactly five keys, no signing material, freshly bounded expiry), invariant enforcement, and the rule that a rejected payment produces no proposal. |
| `tests/report.test.ts` | The plain-language report, payment-impact detection, inconsistency reporting, next steps. |
| `tests/requirements.test.ts` | Official-requirement gaps: the six-decimal USDC conversion cross-checked against the official `atomicAmount(x, 6)` helper, the full EVM proposal field contract (`to` as 20-byte hex, `value` as unsigned decimal wei, `data` as even-length hex, one call only), the five-minute expiry ceiling, a recursive scan for forbidden keys (wallet id, keys, approval modes, signatures, RPC URLs, broadcast instructions, and any fee, gas or slippage field), and the rule that a refusal builds no envelope. |
| `tests/protocol.test.ts` | The built artifact: size and UTF-8 validity, byte-identical rebuilds, no key material, no `.env`, the four tools advertised with compilable schemas, the `paybox-plugin.json` sample executing and validating, every tool called over real stdio with schema-valid structured output, the PayBox envelope surviving the wire, a blocked payment returning an error and no proposal, unknown tools and unknown argument fields being refused without breaking the server, the `explain` preference, the 10-second operation and discovery budget, running the bundle with no dependencies installed, no reachable network capability, and no forbidden fee or simulation claim in any user-visible text. |

The Keccak-256 implementation is hand-written to avoid pulling in a hashing dependency for one
selector. It was verified against `js-sha3` 0.9.3 across 313 inputs — single-block, exact-block-
boundary, multi-block, and 300 random byte arrays — during development; the multi-block values are
pinned in the test suite.

`scripts/probe-protocol.mjs` is a small standalone smoke test that performs a `tools/list` and one
`tools/call` against the built artifact and prints what came back. It is a debugging aid, not part
of the suite.

## 9. Demo

See [`DEMO.md`](./DEMO.md) for a 60–90 second script and the exact tool calls for each scenario.
All figures are illustrative user-supplied numbers, not a real account.

## 10. Limitations and blocked tests

See [`LIMITATIONS.md`](./LIMITATIONS.md) for the honest list, including what could not be verified
in this environment.

## 11. Status vocabulary

These mean different things and the plugin keeps them apart:

- **Locally tested proposal** — `propose_usdc_payment` returned a well-formed unsigned proposal in
  a test. This is what the test suite and the official conformance run verify.
- **PayBox-validated proposal** — PayBox accepted and reviewed a proposal through its own flow.
  This requires portal access and a connected account; see `LIMITATIONS.md`.
- **Executed transaction** — confirmed on-chain. Nothing in this repository does this.

## 12. License

MIT (see [`LICENSE`](./LICENSE)). The PayBox plugin starter files this project builds on are
redistributed as published; the requirement document does not state licence terms for them, and none
are claimed here.

## 13. Web interface (optional)

[`web/`](./web/README.md) is a local dashboard for demoing and testing the plugin. It drives the real
`dist/plugin.mjs` over MCP stdio: every figure on screen comes from a genuine `tools/call`.

```bash
pnpm run build      # if dist/plugin.mjs is not there yet
pnpm run web:dev    # http://127.0.0.1:4173
pnpm run web:test   # 14 end-to-end checks against the real plugin
```

It is a separate deliverable: not bundled into the plugin, not covered by the PayBox conformance run,
and not required for the submission. Upload `dist/plugin.mjs` as always.
