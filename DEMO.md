# StablePilot demo script

Target length: 60–90 seconds. Every figure below is an illustrative user-supplied number, not a real
account. The recipient is a well-known burn address used as a placeholder, never a real person's
address.

## Setup (before recording)

```bash
pnpm install --frozen-lockfile
pnpm run build
```

Start the server on its own so the tool list is visible:

```bash
node dist/plugin.mjs
```

Or paste the JSON from `paybox-plugin.json` into an MCP host config and let the host drive it.

---

## Scenario A — Plan (0:00–0:15)

> "Here's 100 USDC. Ten for spending, seventy to savings, twenty held back as an emergency reserve.
> What does that actually look like?"

Call `plan_stablecoin_allocation`:

```json
{
  "totalUsdc": "100",
  "spendingUsdc": "10",
  "savingsUsdc": "70",
  "emergencyReserveUsdc": "20"
}
```

On screen: spending 10 (10.00%), savings 70 (70.00%), reserve 20 (20.00%), unallocated 0, total
allocated 100.

> "It also says the quiet part out loud: these are my numbers, not a verified wallet balance."

## Scenario B — An allowed payment (0:15–0:35)

> "Now pay 5 USDC."

Call `propose_usdc_payment` with `maxPaymentUsdc: "5"`:

```json
{
  "chain": "base",
  "recipient": "0x000000000000000000000000000000000000dEaD",
  "amountUsdc": "5",
  "availableUsdc": "100",
  "spendingAllocationUsdc": "10",
  "emergencyReserveUsdc": "20",
  "maxPaymentUsdc": "5"
}
```

On screen: the response's only structured key is `io.paybox/transactionProposal`, holding `version: "1"`,
`kind: "evm"`, `chain: "eip155:8453"`, an `expiresAt` four minutes out, and a `transaction` whose `to` is
the official Base USDC contract, whose `value` is `"0"`, and whose `data` begins `0xa9059cbb` — the 5
USDC visible inside it as `0000...4c4b40`.

> "It did not send anything. It did not sign anything. It built an unsigned proposal and told me
> PayBox picks the wallet and I authorize the transfer."

## Scenario C — A blocked payment (0:35–0:55)

> "Now try to pay 15 USDC out of a 10 USDC spending allocation."

Call `check_payment_policy`:

```json
{
  "availableUsdc": "100",
  "spendingAllocationUsdc": "10",
  "emergencyReserveUsdc": "20",
  "paymentAmountUsdc": "15",
  "maxPaymentUsdc": "5"
}
```

On screen: `decision: blocked`, `blockedBy: ["spending_budget"]`, and the sentence "The payment of
15 USDC exceeds the 10 USDC spending allocation by 5 USDC."

> "That is the product. Not a failed transaction — an explanation. And note there is no proposal in
> the response at all, so there is nothing to approve by mistake."

## Scenario D — Emergency reserve protection (0:55–1:15)

> "Say I have a hard floor: never let my balance drop below 50 USDC, whatever my plan says."

Call `check_payment_policy` with `minEmergencyReserveUsdc: "50"`:

```json
{
  "availableUsdc": "100",
  "spendingAllocationUsdc": "60",
  "emergencyReserveUsdc": "20",
  "paymentAmountUsdc": "60",
  "maxPaymentUsdc": "100",
  "minEmergencyReserveUsdc": "50"
}
```

On screen: `decision: blocked`, `blockedBy: ["emergency_reserve"]`, "would leave 40 USDC, below the
minimum emergency reserve you supplied of 50 USDC."

> "The spending budget allowed it. The reserve floor refused it anyway. Lower the floor to 40 and the
> same payment passes — the rule is doing real work, not decoration."

## Scenario E — The PayBox hand-off (1:15–1:30)

> "StablePilot's job ends here. What it hands over is an unsigned proposal in PayBox's format. PayBox
> reviews it, the user authorizes it in the signing window where the key lives, and only then does
> anything reach the chain."

State clearly, on camera and in the description:

- Locally tested proposal: **verified by the test suite**.
- PayBox-validated proposal: **not performed** — no portal credentials or connected account.
- Executed transaction: **not performed, and not something this plugin can do**.

---

## Closing line

> "Agents can already move money. StablePilot is the part that explains why they shouldn't."

## Reproducing the whole thing without recording

```bash
pnpm run verify
```

That runs the typecheck, the 73 unit assertions, the 21 protocol assertions against the built
`dist/plugin.mjs`, the build, and the official conformance assertions.

Every scenario above is asserted in the suite, including the negative cases and the "blocked means
no proposal" rule. (`pnpm test` is the starter's own suite and additionally requires macOS, Linux or
WSL2 — see `LIMITATIONS.md` §7.5.)
