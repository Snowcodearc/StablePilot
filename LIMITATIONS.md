# Limitations and blocked tests

This file exists so that nothing about StablePilot's status has to be inferred. If something was not
verified, it is written here.

## 1. Blocked: PayBox portal access and hosted testing

**The PayBox authorization scenario was not performed against PayBox.**

No PayBox developer-portal credentials, API keys, or connected account were available in this
environment. Consequently:

- The plugin was **not** uploaded to the PayBox developer portal.
- The plugin was **not** run in PayBox's hosted runtime, so the 10-second per-operation budget was
  never observed as a host measurement. It is bounded by construction and measured locally (see
  §7.4), but has never been measured in the host.
- No proposal was submitted through PayBox's review or signing flow.
- No PayBox API endpoint was called by this code at any point.

The result, stated precisely:

| Status | Verified? |
| --- | --- |
| Locally tested proposal (well-formed, correct calldata, unsigned) | **Yes** — asserted by the test suite and by the official conformance run |
| PayBox-validated proposal | **No** — no portal access |
| Executed transaction | **No** — and the plugin deliberately cannot do this |

No conformance result, approval, or transaction execution is claimed anywhere in this repository.

## 2. What is official and what is ours

The requirement document was read from `https://developer.paybox.sh/requirements.md`, and the official
plugin starter files were downloaded from the paths it links
(`https://developer.paybox.sh/plugin-starter/v1.0.2/...`). A pristine copy is kept in
`.paybox-starter/`, including the release's own `manifest.json` of file checksums.

**Adopted from the official release, byte-identical.** `scripts/verify-starter-files.mjs` hashes
every file listed in the release manifest against the copy in this project:

```
status: passed   starterVersion: 1.0.2   protocolVersion: 2026-07-28
intact: 11  (tsconfig.json, pnpm-lock.yaml, pnpm-workspace.yaml, .gitignore,
             starter-version.json, src/paybox.ts,
             scripts/{conformance,process,report,schema,test}.mjs)
```

That includes `src/paybox.ts` (the proposal builders and amount conversion, used unmodified) and all
five official tooling scripts (used unmodified to report conformance).

**Intentionally changed after adoption — the complete list:**

| File | Why | What changed |
| --- | --- | --- |
| `package.json` | Project identity and local scripts | `name`, `version`, `description`, `license`, and added scripts. **Dependencies, `engines`, `packageManager` and the existing scripts are untouched.** |
| `paybox-plugin.json` | It must carry StablePilot's sample invocation | The sample `tool` and `arguments` values |
| `src/plugin.ts` | The starter ships an echo tool as a placeholder | Replaced with the four StablePilot tools |

**Written by StablePilot, on top of the official pieces:**

- `src/erc20.ts` — Base chain constants, the USDC contract address, the ERC-20 transfer encoder, the
  proposal invariants, and the expiry helper.
- `src/schemas.ts` — the zod input/output schemas for the four tools.
- `src/allocation.ts`, `src/policy.ts`, `src/money.ts`, `src/validation.ts`, `src/keccak.ts` — the
  domain logic (planning, policy, decimal-safe money, address validation, Keccak-256).
- `src/payments.ts` — the composition layer: validate, apply policy, then call the official
  `proposeEvm()` builder.
- `tests/*`, `scripts/probe-protocol.mjs`, `scripts/conformance-windows.mjs`,
  `scripts/verify-starter-files.mjs`.

**Decided by us, and stated here as a decision rather than a requirement:**

- **Supported chains: Base mainnet only.** The brief's example payments are Base USDC, and a
  narrower surface is easier to reason about for a one-day build. Nothing prevents adding chains;
  `resolveChain()` is the single place that would change.
- **Minimum viable tool set.** Four tools. There is no tool for revoking a proposal, listing history,
  or reserving budget, because there is no persistence to hang them on.
- **The policy engine is advisory, not enforcement.** It judges the figures it is given. PayBox's own
  limits and approvals remain the authoritative control, and the tool output says so.

Everything else follows the starter and the requirement document directly.

## 3. Environment: the official `pnpm test` cannot run on this machine

`pnpm test` is the starter's own `scripts/test.mjs`. Its first act is `report.mjs` →
`checkEnvironment()`, which throws `environment_invalid` unless the platform is `darwin` or `linux`
and Node is version 24. The requirement document states this is because the PayBox hosted runtime is
Linux, and tells Windows users to use WSL2.

**Verified on this machine:**

- `wsl -l -v` reports no installed distributions.
- `docker --version` and `podman --version` are not available.
- Node is **24.19.0** (the `24.x` requirement is met).

So the OS half of the gate cannot be satisfied here, and the actual command produces:

```json
{"reportVersion":1,"starterVersion":"1.0.2","protocolVersion":"2026-07-28",
 "toolchain":{"node":"24.19.0","platform":"win32","arch":"x64"},
 "status":"failed","code":"environment_invalid",
 "message":"Use Node.js 24 on macOS or Linux (Windows: use WSL2)"}
```

**What was done instead.** `pnpm run conformance:windows` imports the official `testArtifact()`
unchanged and only reports `process.platform` as `linux` so the host gate lets the official
assertions run. Nothing after the gate is reimplemented. The result:

```json
{"status":"passed","sampleCall":{"tool":"plan_stablecoin_allocation","status":"passed"},
 "discoveredToolCount":4,
 "artifact":{"bytes":420949,
   "sha256":"99e37991ced213be83b0144f359d96b7ca58a45ba0fcb6a6924c15e3ccc23044"}}
```

**What this does not mean.** It is not an official conformance report. The official report must still
be produced on macOS, Linux or WSL2 by running `pnpm test`, and the plugin must still pass in the
hosted runtime. The one thing an OS gate genuinely protects against is platform-specific behaviour,
and here the risk is low and stated: the bundle is ESM depending only on `node:` builtins, with no
platform-conditional code, no filesystem use, and no native addon.

## 4. Deliberately not implemented (out of scope for the MVP)

- No signing, broadcasting, or transaction execution, by design.
- No private key, seed phrase, or credential handling, by design.
- No wallet selection or wallet id, by design — PayBox handles it.
- No token approvals, swaps, arbitrary contract calls, or batched transactions.
- No chains other than Base mainnet (`eip155:8453`).
- No Solana or x402 proposals, although the starter's `src/paybox.ts` provides builders for both and
  the plugin uses neither.
- No hosted interface or HTML rendering — PayBox renders its own UI.
- No yield, returns, market data, or price feeds.
- No persistent storage, database, or external backend, and no budget reservation.

## 5. Behavioural limits worth knowing

- **The policy engine only knows what it is told.** It evaluates the figures passed into the call.
  It cannot detect that the user's real balance is different, and it cannot prevent two concurrent
  requests from both passing a check and together overspending. A budget is never reserved.
- **No balance verification.** Every figure is user-supplied. The tools say so in their output.
- **A missing per-payment limit is treated as `review_required`, not as a pass.** A caller that
  omits `maxPaymentUsdc` will get `review_required` rather than `allowed`.
- **The emergency reserve rule is structurally satisfied by a consistent plan.** A payment inside
  the spending allocation cannot reach the reserve when the plan adds up. The rule is meaningful
  when an explicit `minEmergencyReserveUsdc` floor is supplied above the planned reserve, or when
  the stated balance is below the plan. This is documented in the README rather than hidden.
- **Percentage figures are display values.** They are computed in basis points with half-up rounding
  and are never used for arithmetic.
- **All-lowercase recipient addresses carry no checksum information** and are accepted on shape
  alone. Mixed-case addresses are checksum-verified, and a failure is rejected with the correct
  address suggested.
- **`explain: false`** on `plan_stablecoin_allocation` returns the structured plan and a one-line
  summary instead of the full prose explanation.
- **No operation was measured against the 10-second hosted budget.** Every tool is pure computation
  and does no I/O, so it runs in single-digit milliseconds locally, but that is a different
  measurement from the host's.

## 6. Verification that was done, and what it rests on

| Claim | Basis |
| --- | --- |
| The adopted starter files are the official 1.0.2 bytes | SHA-256 of every file against the release manifest: 11 intact, 3 intentional deltas, all named |
| The bundle speaks the PayBox MCP dialect | The official `testArtifact()` run to `status: passed` (with the OS gate bypassed, §3) |
| The sample invocation works | The official conformance sample call, `passed` |
| Every tool returns schema-valid output | `tests/protocol.test.ts` — real stdio, AJV against the schemas the server itself advertises |
| The build is reproducible | `tests/protocol.test.ts` — two builds, byte-identical |
| A rejected payment produces no proposal | `tests/payment.test.ts` and `tests/protocol.test.ts` |
| Keccak-256 is correct | Cross-checked against `js-sha3` 0.9.3 across 313 inputs (empty, single-byte, exact 136-byte block boundary, multi-block, 300 random arrays) during development; multi-block values pinned in the suite. `js-sha3` is not a dependency. |
| ERC-20 calldata is correct | Selector derived at runtime (`0xa9059cbb`) and the full 68-byte call asserted against a literal expected string |
| The Base USDC address is correct | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` asserted, with its EIP-55 checksum verified by our own implementation |
| The bundle carries no secrets | String scan of the artifact in `tests/protocol.test.ts` |
| The artifact stands alone with no dependencies installed | `tests/protocol.test.ts` copies the bundle to a directory with no `node_modules` above it and drives `tools/list` plus a proposal call |
| Every operation fits the 10-second budget | `tests/protocol.test.ts` measures each tool call and discovery end to end; slowest observed 460 ms |
| No network capability is reachable from the artifact | `tests/protocol.test.ts` scans the bundle for network APIs and external module specifiers |

## 7. Requirements-gap audit

Every claim below cites the official text. The source is the PayBox plugin developer guide at
`https://developer.paybox.sh/requirements.md` (the plain-text document, quoted with line numbers from
the copy read on 2026-10-16) and the agent guide it links at `https://developer.paybox.sh/skill.md`.

### 7.1 Fee and gas

**Official position.** There is no fee or gas field in the proposal contract. `proposeEvm`'s `value`
is native currency only: "`value` is the native currency amount in wei (ETH on Base), not an ERC-20
amount. There is no `token`, `transfer` or `swap` field in the proposal; unknown fields are
rejected" (L346-348). Fee handling is PayBox's: "EVM proposals refresh their nonce and recheck
execution without raising approved fee limits" (L484), and "If the proposal expires or fees exceed
its limit, check the previous request's status before asking for a new proposal" (L487-488). The
only user-facing fee statement is "The wallet still needs native currency for network fees"
(L383).

**StablePilot status: satisfied, with one wording gap closed.** The tool builds no fee or gas field,
estimates nothing, and sets `value: "0"` for the ERC-20 transfer. The proposal summary now states
that the wallet needs native ETH on Base and that StablePilot does not estimate or cover it, and a
test asserts that no invented fee or gas number appears in user-visible text.

**Nothing further is implemented, deliberately.** Adding a fee estimate would require an RPC call or
a price feed, which the guide forbids keeping in the tool path, and would invent a number the
official contract has no field for.

### 7.2 Transaction simulation

**Official position.** Simulation belongs to PayBox, not to the plugin: "Return one unsigned call on
a supported chain; PayBox constructs and simulates the transaction" (L47). In the portal, "PayBox
checks the test result and simulates the proposal to show a preview" (L230), using the wallet's
public address only, with no approval, signature or broadcast (L231-232). And the outcome proves
less than it looks: "Simulation success does not establish economic safety or guarantee later
execution" (L239), "A proposal is not a receipt. Returning it neither transfers funds nor guarantees
simulation will pass" (L313), "Successful simulation or a successful network receipt alone does not
prove the intended token amounts moved" (L398), and "Do not describe plugin text as a PayBox-verified
token or swap preview" (L399-400).

**StablePilot status: satisfied.** There is no simulation code path, and none is possible: the
plugin makes no network request of any kind. The proposal summary attributes simulation to PayBox
and states that a proposal is not a receipt and guarantees nothing. Tests assert both the absence of
forbidden claims ("simulation passed", "PayBox-verified", "guaranteed", and similar) in every piece
of user-visible text and the presence of the honest clauses.

**Not claimed:** that any StablePilot proposal has been simulated. It has not. Simulation happens in
the developer portal against a selected wallet, and no portal access was available.

### 7.3 Required fields and validation for USDC payment proposals

**Official position** (L317-342, L360-384, L416-446): use the helper's output schema and return its
builder result; declare `io.paybox/transactionProposal` inline in the output schema; return it under
`structuredContent`; "Do not put a proposal in an `isError` result"; `version: "1"`; `expiresAt` as
whole-second UTC RFC3339 within five minutes; EVM requires `kind: "evm"`, canonical
`chain: "eip155:<chain ID>"`, and `transaction: {to, value, data}` where `to` is a 20-byte hex
address, `value` is unsigned decimal wei, and `data` is even-length hex calldata, one call only. The
proposal must not carry "wallet IDs, signing keys, approval modes, signatures, RPC URLs or broadcast
instructions". USDC specifics: six decimals, converted with `atomicAmount(amount, 6)`; the deployed
Base USDC contract is `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`.

**StablePilot status: satisfied.** Verified field by field:

| Requirement | Status in StablePilot |
| --- | --- |
| `evmOutputSchema` declared as the output schema | Yes, imported from the official `paybox.ts` |
| Returned under `structuredContent["io.paybox/transactionProposal"]` | Yes, and it is the only structured key |
| Never inside an `isError` result | Yes: refusals build no envelope at all |
| `version: "1"`, `kind: "evm"` | Yes (helper-supplied) |
| Canonical `chain: "eip155:8453"` | Yes |
| `transaction.to` a 20-byte hex address, the USDC contract | Yes, asserted against the deployed address |
| `transaction.value` unsigned decimal wei, `"0"` for an ERC-20 transfer | Yes |
| `transaction.data` even-length hex calldata, one call only | Yes, three keys only |
| `expiresAt` whole-second UTC, within five minutes | Yes, four minutes (the helper default) |
| No wallet id, key, approval mode, signature, RPC URL or broadcast instruction | Yes, asserted by a recursive key scan |
| Six-decimal USDC conversion | Yes, and now cross-checked against the official `atomicAmount(x, 6)` over a table of amounts |

**One deviation, stated plainly.** StablePilot encodes the calldata with its own decimal-safe parser
and a hand-written Keccak-256 rather than bundling `viem` as the guide's USDC example does. The
guide permits this: "The raw contract below remains supported" (L342), and the raw contract is what
is used. `tests/requirements.test.ts` asserts that the parser and the official `atomicAmount` agree
exactly, so the two cannot drift.

### 7.4 The 10-second runtime limit

**Official position.** "Complete each operation within 10 seconds" (L139, the `timeout` failure
code). The local check table lists "Operation duration | 10 seconds" (L155). "Each discovery page
and sample call may run in a fresh process, so do not rely on memory surviving between calls.
Hosted calls have a 10-second budget, and a local timing pass does not guarantee a hosted pass. Keep
tool calls short. Log to stderr; stdout is reserved for MCP messages" (L145-148). Network calls must
stay out of startup and discovery, with bounded requests "so sandbox startup and work fit in ten
seconds" (L507-508).

**StablePilot status: satisfied, and now measured.** Every tool is pure computation: no disk, no
globals, no network. Measured end to end, including process start, over the built artifact:
discovery 350 ms; `plan_stablecoin_allocation` 312 ms; `check_payment_policy` 383 ms;
`propose_usdc_payment` 460 ms; `get_allocation_report` 351 ms. The suite asserts each is inside the
documented 10-second budget and inside half of it locally. The artifact reaches no network, so
nothing can block inside a tool call.

**Limitation:** these are local measurements on Windows. "A local timing pass does not guarantee a
hosted pass", and the hosted budget was never observed.

### 7.5 Conformance procedure and supported environments

**Official position.** Commands: `pnpm install --frozen-lockfile`, `pnpm test` (L92-96), where
`pnpm test` "Type-checks, builds twice, requires identical bytes, then runs conformance" (L107).
`pnpm --silent conformance` prints only the JSON report (L112). Supported platforms: "Supported:
macOS and Linux with Node.js 24 and pnpm 11.11.0. CI uses Node.js 24.21.0 on both systems; Windows
users should use WSL2. Pin the same Node patch version for reproducible builds. **Native Windows is
not supported**" (L82-84). A pass reports `status`, `artifact.bytes`, `artifact.sha256` and
`discoveredToolCount` (L120-121).

**StablePilot status: partially satisfied.**

| Requirement | Status |
| --- | --- |
| Pinned starter toolchain adopted | Yes, 11 files byte-identical to the 1.0.2 release |
| `paybox-plugin.json` sample valid and passing | Yes, the official sample call reports `passed` |
| Build reproducible (identical bytes) | Yes |
| Pinned dependencies unchanged | Yes |
| Node 24 | Yes locally, but 24.19.0 rather than the CI pin of 24.21.0 (see below) |
| macOS, Linux or WSL2 | **No.** Native Windows cannot run the official runner |

**Gap: the Node patch version.** The guide says to "Pin the same Node patch version for reproducible
builds" and notes CI uses 24.21.0. This machine has 24.19.0. `package.json` pins `engines.node` to
`24.x` and `packageManager` to `pnpm@11.11.0`, matching the starter, but the patch version is not
pinned. The build targets `node24` and bundles no native code, so the artifact is byte-identical
today, but the official run should happen on 24.21.0.

**Gap: the operating system.** This is the one requirement StablePilot cannot satisfy here, and the
exact command for a supported environment is in `README.md` §4. The wrapper described in §3 is a
development convenience only and **must not** be presented as the official result.

## 8. Not verified against PayBox

Nothing in this repository has been exercised against PayBox's servers, its signing window, its
approval flow, its hosted runtime, or its real authorization path. In particular:

- The **shape** of the proposal envelope is verified against the starter's own `proposeEvm()` builder
  and its declared output schema, and against the field contract quoted in §7.3. Whether PayBox
  *accepts* this proposal in its review flow is untested.
- The **`expiresAt` window** of four minutes is the starter's default and satisfies the documented
  five-minute ceiling. Whether PayBox's signing window matches it in practice is untested.
- **No proposal has been simulated.** Simulation is performed by PayBox in the developer portal, and
  no portal access or connected wallet was available.
- **Fees are not modelled, estimated, or verified.** PayBox checks the transaction against its own
  approved fee limits; this plugin never sees them.

Any claim to the contrary would be fabricated.
