// Payment Proposals.
//
// This screen builds an unsigned `io.paybox/transactionProposal` and shows it
// exactly as the plugin returned it. Nothing here signs, sends or simulates a
// transfer, and the copy never suggests otherwise.

import { field, readFields, selectField, setBusy, setErrors } from "../components/fields.js";
import {
  alertBox,
  copyField,
  decisionBadge,
  emptyState,
  outcomeBadge,
  pageHead,
  reveal,
} from "../components/ui.js";
import { esc } from "../lib/dom.js";
import { addressError, amountError, dateTime, money } from "../lib/format.js";
import { callTool } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { addActivity, getSettings, updateSettings } from "../lib/store.js";

let expiryTimer = null;

const UNSIGNED_NOTICE = `
  <div class="alert" data-tone="review" role="note">
    <div class="alert-body">
      <div class="alert-title">Unsigned proposal, pending PayBox authorisation</div>
      <div>
        StablePilot has only prepared the transaction data. Nothing has been signed, broadcast or paid.
        PayBox validates the request, selects the wallet and asks you to authorise it.
      </div>
    </div>
  </div>`;

export async function render(root) {
  clearInterval(expiryTimer);
  const settings = getSettings();

  root.innerHTML = `
    ${pageHead(
      "Payment Proposals",
      "Prepare an unsigned USDC transfer for PayBox to validate and authorise. StablePilot never signs or sends anything.",
    )}
    <div class="form-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Proposal details</h2>
            <p class="panel-sub">Network, recipient, amount and the rules that must allow it</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form" id="proposal-form" novalidate>
            <div class="form-grid">
              ${field({
                id: "recipient",
                label: "Recipient address",
                hint: "40 hex characters after 0x. Mixed-case addresses must carry a valid EIP-55 checksum.",
                value: settings.recipient,
                suffix: "",
                placeholder: "0x0000000000000000000000000000000000000000",
                inputmode: "text",
                span: true,
              })}
              ${field({
                id: "amountUsdc",
                label: "Amount",
                hint: "Encoded into the ERC-20 transfer call data.",
                value: settings.lastProposalAmount ?? "",
                placeholder: "25",
              })}
              ${selectField({
                id: "chain",
                label: "Network",
                hint: "Base mainnet. Both values are the same chain, one as a name and one as a CAIP-2 id.",
                value: settings.chain ?? "base",
                options: [
                  { value: "base", label: "Base" },
                  { value: "eip155:8453", label: "Base · eip155:8453" },
                ],
              })}
              ${field({
                id: "availableUsdc",
                label: "Available balance",
                hint: "Your stated total, used by the policy check.",
                value: settings.totalUsdc,
              })}
              ${field({
                id: "spendingAllocationUsdc",
                label: "Spending allocation",
                hint: "The payment must fit inside this.",
                value: settings.spendingUsdc,
              })}
              ${field({
                id: "emergencyReserveUsdc",
                label: "Emergency reserve",
                hint: "Must survive the payment.",
                value: settings.emergencyReserveUsdc,
              })}
              ${field({
                id: "maxPaymentUsdc",
                label: "Maximum per payment",
                hint: "Without it the payment needs review, so no proposal is built.",
                value: settings.maxPaymentUsdc,
                optional: true,
              })}
              ${field({
                id: "minEmergencyReserveUsdc",
                label: "Reserve floor",
                hint: "Optional override of the reserve allocation.",
                value: settings.minEmergencyReserveUsdc,
                optional: true,
              })}
            </div>
            <div class="button-row">
              <button class="button button-primary" type="submit" id="proposal-submit">
                Build unsigned proposal
              </button>
            </div>
            <p class="tiny faint">
              This creates transaction data only. No keys are requested, nothing is signed, and no funds move.
            </p>
          </form>
        </div>
      </section>

      <section class="panel" id="proposal-result" aria-live="polite">
        ${emptyState({
          title: "No proposal yet",
          body: "A proposal is built only when your rules allow the payment. Otherwise the plugin refuses, and this panel shows why.",
        })}
      </section>
    </div>`;

  const form = root.querySelector("#proposal-form");
  const result = root.querySelector("#proposal-result");
  const submit = root.querySelector("#proposal-submit");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = readFields(form);

    const errors = {
      recipient: addressError(values.recipient, { required: true }),
      amountUsdc: amountError(values.amountUsdc, { label: "Amount" }),
      availableUsdc: amountError(values.availableUsdc, { label: "Available balance" }),
      spendingAllocationUsdc: amountError(values.spendingAllocationUsdc, { label: "Spending allocation" }),
      emergencyReserveUsdc: amountError(values.emergencyReserveUsdc, { label: "Emergency reserve" }),
      maxPaymentUsdc: amountError(values.maxPaymentUsdc, { label: "Maximum per payment", required: false }),
      minEmergencyReserveUsdc: amountError(values.minEmergencyReserveUsdc, {
        label: "Reserve floor",
        required: false,
      }),
    };

    if (setErrors(form, errors)) {
      result.innerHTML = alertBox(
        "warn",
        "Some fields need fixing",
        "Correct the highlighted fields and try again. No proposal was requested.",
      );
      return;
    }

    const args = {
      chain: values.chain,
      recipient: values.recipient,
      amountUsdc: values.amountUsdc,
      availableUsdc: values.availableUsdc,
      spendingAllocationUsdc: values.spendingAllocationUsdc,
      emergencyReserveUsdc: values.emergencyReserveUsdc,
    };
    if (values.maxPaymentUsdc) args.maxPaymentUsdc = values.maxPaymentUsdc;
    if (values.minEmergencyReserveUsdc) args.minEmergencyReserveUsdc = values.minEmergencyReserveUsdc;

    updateSettings({
      recipient: values.recipient,
      chain: values.chain,
      totalUsdc: values.availableUsdc,
      spendingUsdc: values.spendingAllocationUsdc,
      emergencyReserveUsdc: values.emergencyReserveUsdc,
      maxPaymentUsdc: values.maxPaymentUsdc,
      minEmergencyReserveUsdc: values.minEmergencyReserveUsdc,
      lastProposalAmount: values.amountUsdc,
    });

    setBusy(submit, true, "Building…");
    result.innerHTML = `
      <div class="panel-body">
        <div class="inline small muted"><span class="spinner" aria-hidden="true"></span>Running propose_usdc_payment…</div>
        <div class="stack" style="margin-top:18px">
          <div class="skeleton" style="height:64px"></div>
          <div class="skeleton" style="height:14px"></div>
          <div class="skeleton" style="height:14px;width:70%"></div>
        </div>
      </div>`;

    try {
      const { result: toolResult, durationMs } = await callTool("propose_usdc_payment", args);

      if (toolResult?.isError === true) {
        const message =
          toolResult.content?.[0]?.text ?? "The plugin did not build a proposal for this payment.";
        const { headline, detail, decision } = readRefusal(message);

        result.innerHTML = `
          <div class="panel-head">
            <div>
              <h2 class="panel-title">No proposal built</h2>
              <p class="panel-sub">${esc(durationMs)}ms · nothing was signed or sent</p>
            </div>
            ${decision ? decisionBadge(decision) : `<span class="badge" data-tone="neutral">No proposal</span>`}
          </div>
          <div class="panel-body">
            ${alertBox(decision === "review_required" ? "warn" : "error", headline,
              "The plugin only builds a proposal when your own rules allow the payment.")}
            ${
              detail
                ? `<details class="details" style="margin-top:14px">
                     <summary>Full plugin response</summary>
                     <pre class="code" tabindex="0">${esc(detail)}</pre>
                   </details>`
                : ""
            }
            <div class="button-row" style="margin-top:14px">
              <a class="button" href="/checker">Open Payment Checker</a>
              <button class="button button-quiet" type="button" data-retry>Try again</button>
            </div>
          </div>`;
        addActivity({
          tool: "propose_usdc_payment",
          outcome: decision ?? "refused",
          summary: `${money(values.amountUsdc)} USDC to ${shortAddress(values.recipient)} · no proposal`,
          durationMs,
        });
        wireRetry(result, form);
        reveal(result);
        toast(
          decision === "review_required" ? "Needs review: no proposal built" : "No proposal: the plugin refused this payment",
          { tone: decision === "review_required" ? "default" : "error" },
        );
        return;
      }

      const proposal = toolResult?.structuredContent?.["io.paybox/transactionProposal"];
      if (!proposal || proposal.kind !== "evm") {
        result.innerHTML = alertBox(
          "error",
          "Unexpected response",
          "The plugin returned no EVM transaction proposal, so nothing can be shown.",
        );
        return;
      }

      result.innerHTML = proposalResult(proposal, {
        amountUsdc: values.amountUsdc,
        durationMs,
        note: toolResult.content?.[0]?.text ?? "",
      });
      reveal(result);
      startExpiryCountdown(result, proposal.expiresAt);

      addActivity({
        tool: "propose_usdc_payment",
        outcome: "proposal",
        summary: `${money(values.amountUsdc)} USDC to ${shortAddress(proposal.transaction.to)} · unsigned`,
        durationMs,
      });
      toast("Unsigned proposal prepared");
    } catch (error) {
      result.innerHTML = `
        <div class="panel-head"><h2 class="panel-title">Could not run the tool</h2></div>
        <div class="panel-body">
          ${alertBox("error", "Request failed", esc(error?.message ?? String(error)))}
          <div class="button-row" style="margin-top:14px">
            <button class="button" type="button" data-retry>Try again</button>
          </div>
        </div>`;
      wireRetry(result, form);
      reveal(result);
    } finally {
      setBusy(submit, false);
    }
  });
}

function wireRetry(panel, form) {
  panel.querySelector("[data-retry]")?.addEventListener("click", () => form.requestSubmit());
}

function shortAddress(address) {
  return address && address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : (address ?? "");
}

/**
 * The refusal arrives as a block of text, not structured content. Take its first
 * line as the headline, keep the rest verbatim, and read the decision it states
 * rather than guessing one.
 */
function readRefusal(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const decision = /\bDecision:\s*(allowed|blocked|review_required)\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
  return {
    headline: lines[0] ?? "No proposal was built.",
    detail: lines.slice(1).join("\n"),
    decision,
  };
}

/** The USDC contract's `transfer(address,uint256)` selector, if the data starts with it. */
function calldataKind(data) {
  if (!data || data === "0x") return "empty calldata";
  if (data.startsWith("0xa9059cbb")) return "ERC-20 transfer(address, uint256)";
  return `${data.slice(0, 10)} call`;
}

function startExpiryCountdown(panel, expiresAt) {
  clearInterval(expiryTimer);
  const node = panel.querySelector("[data-expiry]");
  if (!node) return;

  const deadline = Date.parse(expiresAt);
  const paint = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      node.textContent = "expired";
      node.dataset.state = "expired";
      clearInterval(expiryTimer);
      return;
    }
    const seconds = Math.floor(remaining / 1000);
    node.textContent = `in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    node.dataset.state = "live";
  };

  paint();
  expiryTimer = setInterval(paint, 1000);
}

function proposalResult(proposal, { amountUsdc, durationMs, note }) {
  const json = JSON.stringify({ "io.paybox/transactionProposal": proposal }, null, 2);
  const { transaction } = proposal;

  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Unsigned proposal</h2>
        <p class="panel-sub">${esc(durationMs)}ms · built by propose_usdc_payment</p>
      </div>
      ${outcomeBadge("proposal")}
    </div>
    <div class="panel-body results-enter">
      ${UNSIGNED_NOTICE}

      <div class="kv" style="margin-top:16px">
        <div class="kv-row">
          <div class="kv-key">Network</div>
          <div class="kv-value">Base · ${esc(proposal.chain)}</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Recipient</div>
          <div class="kv-value mono" style="word-break:break-all">${esc(transaction.to)}</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Amount requested</div>
          <div class="kv-value">${esc(money(amountUsdc))} USDC <span class="faint">(encoded in calldata)</span></div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Native value</div>
          <div class="kv-value mono">${esc(transaction.value)} wei</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Call</div>
          <div class="kv-value">${esc(calldataKind(transaction.data))}</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Expires</div>
          <div class="kv-value">
            ${esc(dateTime(proposal.expiresAt))}
            <span class="badge" data-tone="review" data-expiry>checking…</span>
          </div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Proposal version</div>
          <div class="kv-value mono">${esc(proposal.version)} · ${esc(proposal.kind)}</div>
        </div>
      </div>

      <p class="eyebrow" style="margin:20px 0 6px">Transaction data</p>
      ${copyField("Recipient", transaction.to)}
      ${copyField("Calldata", transaction.data, { truncate: false })}

      <div class="button-row" style="margin-top:16px">
        <button class="button" type="button" data-copy='${esc(json)}'
          data-copy-label="Proposal JSON copied">Copy proposal JSON</button>
      </div>

      <details class="details" style="margin-top:16px">
        <summary>Full proposal object</summary>
        <pre class="code" tabindex="0" aria-label="Proposal JSON">${esc(json)}</pre>
      </details>

      ${
        note
          ? `<p class="small faint" style="margin-top:14px">Plugin note: ${esc(note)}</p>`
          : ""
      }
    </div>
    <div class="panel-foot">
      PayBox reads <code>io.paybox/transactionProposal</code> from this response. It decides whether to simulate or
      present the payment, and only your wallet can authorise it.
    </div>`;
}

// Copies the JSON built for the visible proposal rather than trusting an attribute.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-json]");
  if (!button || !lastProposal) return;
  event.preventDefault();
  const { toast: showToast } = await import("../lib/toast.js");
  const { copyText } = await import("../lib/toast.js");
  copyText(JSON.stringify({ "io.paybox/transactionProposal": lastProposal }, null, 2), "Proposal JSON copied");
  void showToast;
});
