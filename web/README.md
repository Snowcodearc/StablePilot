# StablePilot web interface

A local dashboard for the StablePilot PayBox plugin. It calls the **real plugin**
(`dist/plugin.mjs`) over MCP stdio and shows what comes back. There is no mock
data, no reimplementation of the allocation or policy logic, and no second copy
of the rules in the browser.

This directory is **not** part of the plugin. The artifact you upload to PayBox
is still `dist/plugin.mjs` on its own; nothing under `web/` is bundled into it,
and the plugin's own test suite and conformance checks are untouched.

---

## Run it

Requirements: Node 24 (already required by the plugin). No install step, no
build step, no external services.

```bash
# from the repository root
pnpm install            # only if you have not already
pnpm run build          # produces dist/plugin.mjs, required by the server
pnpm run web:dev        # http://127.0.0.1:4173
```

Without pnpm (npm works the same for these two scripts):

```bash
node web/server/index.mjs
```

The server refuses to start if the artifact is missing, and tells you to build it.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port. `0` picks a free port (used by the tests). |
| `HOST` | `127.0.0.1` | Bind address. Keep it on localhost unless you mean to expose it. |
| `PLUGIN_ARTIFACT` | `<repo>/dist/plugin.mjs` | Absolute path to a different plugin build. |

Nothing secret is read or forwarded. The browser never sees the artifact path,
except through the read-only `/api/health` summary shown on Settings.

---

## How it works

```
browser (ES modules, no framework)
   │  fetch /api/tools/:name
   ▼
web/server/index.mjs          Node http server, static files, JSON API
   │  tools/call over stdio
   ▼
web/server/mcp-client.mjs     spawns dist/plugin.mjs for each call
   │  newline-delimited JSON-RPC, protocolVersion 2026-07-28
   ▼
dist/plugin.mjs               the real plugin, unmodified
```

One plugin process per tool call, mirroring the hosted execution model, with the
same 10-second budget. That costs about 0.7–1.3 s per call and keeps each call
isolated: no state leaks between a block and the next attempt.

| Screen | Tool |
| --- | --- |
| Overview | `plan_stablecoin_allocation` + `get_allocation_report` |
| Allocation Planner | `plan_stablecoin_allocation` |
| Payment Checker | `check_payment_policy` |
| Payment Proposals | `propose_usdc_payment` |
| Settings | `tools/list` (via `/api/tools`) and the artifact fingerprint |

`GET /api/health`, `GET /api/tools`, `POST /api/tools/<name>` with
`{"arguments": {...}}`. Unknown tool names return 404 without touching the plugin.

---

## What the interface will not do

- It will not claim a wallet balance. Every figure is typed in by you and is
  labelled as yours: no wallet is connected and no on-chain balance is read.
- It will not overrule the plugin. A block stays a block; "review required" is
  never presented as allowed. For a refused proposal the decision is read from
  the plugin's own text, not inferred by the UI.
- It will not imply a payment happened. Proposals are labelled unsigned,
  pending PayBox authorisation. Nothing is signed, simulated or broadcast, and
  no private key is ever requested.
- It will not call local history blockchain history. Activity History is
  `localStorage`, capped at 60 entries, and says so.

---

## Test it

```bash
pnpm run web:test
```

14 checks, roughly 30 seconds. They spawn the server on a free port and drive
the same endpoints the browser uses, so a pass means the plugin really answered:

- discovery: four tools, real bundle hash, no secrets in the response;
- schemas: the required fields the forms are built from;
- plan 1,000 → 300 / 500 / 200 → percentages 30 / 50 / 20, unallocated 0,
  savings goal 600 missed by 100;
- plan refusals: over-allocation and a malformed amount;
- policy: `allowed`, `blocked` (spending budget and per-payment limit), and
  `review_required` when no per-payment limit is given;
- proposal: `io.paybox/transactionProposal`, `eip155:8453`, ERC-20 transfer
  selector, no signature field, and no proposal at all when review is required;
- static shell, client-route fallback, path traversal, unknown tools/endpoints.

### Manual walkthrough

1. **Plan** — Allocation Planner, `1000 / 300 / 500 / 200`, savings goal `600`,
   Run. Expect 30 / 50 / 20 %, unallocated 0, goal not met, short by 100.
2. **Change it** — set spending to `200` and run again; percentages and the
   donut follow the new call.
3. **Break it** — enter `1,000` and `-5`: inline errors, nothing is sent. Then
   `900 / 500 / 200` on a 1,000 total: the plugin refuses and says by how much.
4. **Check a payment** — Payment Checker, 50 USDC with a 100 limit: Allowed,
   with every rule listed. 500 USDC: Blocked. Clear the limit: Review required.
5. **Propose** — Payment Proposals, a valid `0x…` recipient and an allowed
   amount: an unsigned proposal with network, recipient, calldata and a live
   expiry countdown. Nothing is sent anywhere.
6. **History** — Activity History lists every call with outcome and timing;
   filter by kind, download JSON, clear it.
7. **Responsive** — narrow the window below 860 px: the sidebar becomes a
   drawer. Nothing should scroll sideways.
8. **Isolation** — stop the server and reload: the request fails visibly rather
   than falling back to demo data.

---

## Deployment

The interface is not a static site. It needs the Node process above, because the
plugin is a stdio MCP server and only that process can spawn it.

- **Local demo / screen recording:** `pnpm run web:dev`, as above.
- **Hosted (long-lived process):** any Node 24 host, with `pnpm run build` in the
  build step so `dist/plugin.mjs` exists. Set `HOST=0.0.0.0` and the platform's
  `PORT`.
- **Vercel Functions:** the checked-in `vercel.json` builds the plugin, serves
  `web/public` as the static output, and routes `/api/*` to
  `api/[...path].mjs`, which imports the same request handler. The function
  bundle includes `dist/plugin.mjs` so each call can still spawn the real plugin
  over MCP stdio. No dashboard output-directory override is needed.
- **Static hosting (Vercel static output, GitHub Pages, Netlify drop):** not
  possible. There is no HTTP MCP entry point and no build output to serve; a
  static host would serve the shell, and every tool call would fail.

The PayBox submission is unaffected by any of this: upload `dist/plugin.mjs`.
