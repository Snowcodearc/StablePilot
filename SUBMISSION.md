# StablePilot — hackathon submission

## One line

An AI stablecoin pilot that plans your USDC allocations, refuses payments that break your own
rules, and hands PayBox an unsigned proposal only when everything checks out.

## Short description

> Plan USDC allocations, check payment rules, and prepare controlled Base payments through PayBox.

## Long description

> StablePilot helps users turn stablecoin goals into structured allocations and policy-aware payment
> proposals. It calculates spending, savings and emergency reserves, evaluates proposed payments
> against user-defined constraints, and prepares eligible Base USDC transfers for PayBox to review
> and authorize. It never handles private keys or executes transactions independently.

## The problem

Telling an agent "spend up to 5 USDC" is not a plan. It is one number. It says nothing about what
the money is for, what must be protected, or what the consequence of a payment is. Agents can move
money; they are much worse at explaining whether they *should*.

## The idea

Make the allocation the centre of the product, and make the policy check a first-class, structured
answer rather than an error code.

StablePilot treats a USDC balance as three purposes — spending, savings, emergency reserve — and
then judges every proposed payment against that structure. The result is that the interesting
moment in the product is a **refusal**: the user asks for 15 USDC, and instead of a failed
transaction they get "that exceeds your 10 USDC spending allocation by 5 USDC, leaving nothing for
the rest of the period."

## What was built

A PayBox plugin built on the official PayBox plugin starter **v1.0.2**: a standard TypeScript MCP
server (protocol version `2026-07-28`) with four tools, no network access, and a deterministic
single-file bundle. Eleven of the starter's files are adopted byte-identically, including
`src/paybox.ts` and all five official tooling scripts; three are intentionally changed and each is
named and justified in `LIMITATIONS.md` §2.

| Tool | What it does |
| --- | --- |
| `plan_stablecoin_allocation` | Splits a total into spending / savings / emergency reserve with amounts, percentages, unallocated remainder, and savings-goal verdict. |
| `check_payment_policy` | Evaluates one payment against spending budget, per-payment limit, reserve floor and recipient validity. Returns `allowed` / `blocked` / `review_required`. |
| `propose_usdc_payment` | Validates, checks policy, then builds an unsigned `io.paybox/transactionProposal` for a Base USDC ERC-20 transfer. |
| `get_allocation_report` | Explains the allocation and a payment's impact in plain language for someone who has never used DeFi. |

## Why this is specific to PayBox

- **The product is scoped to PayBox's model.** StablePilot plans and proposes; PayBox reviews,
  authorizes and signs. The plugin has no key handling, no signing, no broadcasting, and no wallet
  selection, because that is PayBox's job and its whole security argument.
- **The output is PayBox's output.** `propose_usdc_payment` returns a real
  `io.paybox/transactionProposal` with `chain: "eip155:8453"`, the official Base USDC contract, zero
  native value, and correct ERC-20 calldata.
- **The vocabulary respects the boundary.** Every refusal and every success message states that
  StablePilot's policy check is its own review of supplied figures, not a PayBox-enforced limit, and
  that building a proposal is not a completed payment.

## Engineering decisions worth calling out

- **Integer money.** All amounts are `bigint` atomic units. No `number` ever holds a token amount.
- **Derived, not hardcoded, calldata.** The ERC-20 selector is computed from a hand-written
  Keccak-256 at runtime and pinned by tests to `0xa9059cbb`. That implementation was cross-checked
  against `js-sha3` across 313 inputs.
- **EIP-55 checksum verification.** A mixed-case recipient with a bad checksum is rejected with the
  correct address suggested. Typos in addresses are the most common way money goes to the wrong
  place.
- **Refusals produce nothing.** A payment that fails policy never reaches proposal construction.
- **Self-checking proposals.** Every proposal is validated against its own invariants before it
  leaves the plugin; a violation throws rather than emitting something approvable.
- **Statelessness by design.** No disk, no globals, no reservation. Every call carries its own
  figures, because PayBox may run each operation in a fresh sandbox.
- **Deterministic build.** Two builds produce byte-identical bytes, asserted by a test.

## Verification

| What | How | Result |
| --- | --- | --- |
| Provenance | SHA-256 of every adopted starter file against the official release manifest | 11 intact, 0 unexplained changes |
| Protocol conformance | The official `testArtifact()` — artifact checks, `tools/list`, schema compilation, the sample call | `status: passed`, 4 tools discovered |
| Unit behaviour | 73 assertions across allocation, policy, money, the proposal contract and the official requirement gaps | all pass |
| End-to-end protocol | 21 assertions spawning the built `dist/plugin.mjs` over real MCP stdio, output validated with AJV against the schemas the server advertises | all pass |
| Reproducible build | Two builds compared byte-for-byte | identical |
| Standalone bundling | The artifact copied somewhere with no `node_modules`, then driven over stdio | both calls succeed |
| 10-second budget | Every operation and discovery timed end to end, including process start | slowest 460 ms |
| No network | Bundle scanned for network APIs and non-`node:` module specifiers | none reachable |
| Requirement gaps | Fee/gas, simulation, proposal fields, forbidden keys, honest wording | audited in `LIMITATIONS.md` §7 |

Reproduce with `pnpm run verify`.

### The artifact

```
dist/plugin.mjs
420,949 bytes
sha256 99e37991ced213be83b0144f359d96b7ca58a45ba0fcb6a6924c15e3ccc23044
```

That is the file to upload. It is reproducible from these sources: `pnpm run build` twice produces
byte-identical output, asserted in `tests/protocol.test.ts`.

The one caveat, stated plainly: the *official* `pnpm test` refuses
to run on native Windows (`environment_invalid`; the hosted runtime is Linux) and this machine has
no WSL2 or container runtime. `pnpm run conformance:windows` therefore runs the official
`testArtifact()` unchanged with only the OS gate bypassed, and prints a report that says so. That is
not an official conformance report and must not be cited as one. `LIMITATIONS.md` §3 says exactly
what it does and does not establish, and §7.5 records the two gaps against the official environment
requirement: the operating system, and the Node patch version (24.19.0 here against the starter CI's
24.21.0).

## Demo

Starting balance 100 USDC, spending 10, savings 70, reserve 20, maximum individual payment 5. Five
scenarios: plan, allowed payment, blocked payment, emergency reserve protection, and the PayBox
authorization hand-off. Script and exact calls in [`DEMO.md`](./DEMO.md).

## Honest status

- The plugin, the artifact, and the test suite are complete and verified locally.
- The plugin is built on the official starter 1.0.2, and the official conformance assertions pass
  locally against the built bundle.
- PayBox hosted testing and portal submission were **not** performed: no portal credentials were
  available in this environment, and no proposal was ever sent to PayBox. No PayBox API endpoint was
  called by this code.
- The official `pnpm test` cannot run on this machine (Windows, no WSL2). The exact command, its
  exact `environment_invalid` output, and the local equivalent are all reproduced verbatim in
  [`LIMITATIONS.md`](./LIMITATIONS.md) §3 rather than papered over. The command for a supported
  machine is in `README.md` §4.
- **No proposal has been simulated.** PayBox simulates proposals in the developer portal against a
  selected wallet; no portal access or connected wallet was available, so the plugin claims no
  simulation result. The plugin has no simulation code path and makes no network request.
- **No fee or gas figure is estimated anywhere.** The proposal contract has no fee field, and the
  user-facing text says only that the wallet needs native ETH on Base to pay the network fee.
- The upload artifact is `dist/plugin.mjs`.

### What to upload, and what the host needs

- **Artifact:** `dist/plugin.mjs` (single file, 420,949 bytes, ESM, no native addons).
- **Manifest:** `paybox-plugin.json` with the sample invocation.
- **Runtime:** Node.js 24, no environment variables, no secrets, no API keys, no filesystem paths.
- **Network:** none. The plugin makes no outbound requests and needs no allow-listed hostnames.
- **Dependencies:** bundled into the artifact. Nothing is installed at runtime.
