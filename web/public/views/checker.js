// Payment Checker.
//
// The decision shown is the plugin's, rendered as returned. The interface never
// upgrades "review required" to allowed, or explains away a block.

import { field, readFields, setBusy, setErrors } from "../components/fields.js";
import { alertBox, decisionBadge, decisionPanel, emptyState, pageHead, reveal } from "../components/ui.js";
import { esc } from "../lib/dom.js";
import { addressError, amountError, money } from "../lib/format.js";
import { callTool } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { addActivity, getSettings, updateSettings } from "../lib/store.js";

export async function render(root) {
  const settings = getSettings();

  root.innerHTML = `
    ${pageHead(
      "Payment Checker",
      "Test one payment against the rules you set. The plugin returns allowed, blocked or review required, and the reasons for it.",
    )}
    <div class="form-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Payment and rules</h2>
            <p class="panel-sub">Prefilled from your saved plan</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form" id="check-form" novalidate>
            <div class="form-grid">
              ${field({
                id: "paymentAmountUsdc",
                label: "Payment amount",
                hint: "The amount you are considering.",
                value: "",
                placeholder: "50",
                span: true,
              })}
              ${field({
                id: "availableUsdc",
                label: "Available balance",
                hint: "The total you say you have.",
                value: settings.totalUsdc,
              })}
              ${field({
                id: "spendingAllocationUsdc",
                label: "Spending allocation",
                hint: "The spending budget from your plan.",
                value: settings.spendingUsdc,
              })}
              ${field({
                id: "emergencyReserveUsdc",
                label: "Emergency reserve",
                hint: "The reserve that must survive the payment.",
                value: settings.emergencyReserveUsdc,
              })}
              ${field({
                id: "maxPaymentUsdc",
                label: "Maximum per payment",
                hint: "Without a limit the plugin cannot clear a payment automatically.",
                value: settings.maxPaymentUsdc,
                placeholder: "100",
                optional: true,
              })}
              ${field({
                id: "minEmergencyReserveUsdc",
                label: "Reserve floor",
                hint: "Overrides the reserve allocation above when set.",
                value: settings.minEmergencyReserveUsdc,
                optional: true,
              })}
              ${field({
                id: "recipient",
                label: "Recipient address",
                hint: "Optional. Mixed-case addresses need a valid EIP-55 checksum.",
                value: settings.recipient,
                suffix: "",
                placeholder: "0x…",
                inputmode: "text",
                span: true,
              })}
            </div>
            <div class="button-row">
              <button class="button button-primary" type="submit" id="check-submit">Check payment</button>
            </div>
          </form>
        </div>
      </section>

      <section class="panel" id="check-result" aria-live="polite">
        ${emptyState({
          title: "No check yet",
          body: "Enter an amount and run the tool. You will see the decision, each rule it evaluated, and the balance left after the payment.",
        })}
      </section>
    </div>`;

  const form = root.querySelector("#check-form");
  const result = root.querySelector("#check-result");
  const submit = root.querySelector("#check-submit");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = readFields(form);

    const errors = {
      paymentAmountUsdc: amountError(values.paymentAmountUsdc, { label: "Payment amount" }),
      availableUsdc: amountError(values.availableUsdc, { label: "Available balance" }),
      spendingAllocationUsdc: amountError(values.spendingAllocationUsdc, { label: "Spending allocation" }),
      emergencyReserveUsdc: amountError(values.emergencyReserveUsdc, { label: "Emergency reserve" }),
      maxPaymentUsdc: amountError(values.maxPaymentUsdc, { label: "Maximum per payment", required: false }),
      minEmergencyReserveUsdc: amountError(values.minEmergencyReserveUsdc, {
        label: "Reserve floor",
        required: false,
      }),
      recipient: addressError(values.recipient),
    };

    if (setErrors(form, errors)) {
      result.innerHTML = alertBox(
        "warn",
        "Some fields need fixing",
        "Correct the highlighted fields and run the check again. Nothing was sent.",
      );
      return;
    }

    const args = {
      availableUsdc: values.availableUsdc,
      spendingAllocationUsdc: values.spendingAllocationUsdc,
      emergencyReserveUsdc: values.emergencyReserveUsdc,
      paymentAmountUsdc: values.paymentAmountUsdc,
    };
    if (values.maxPaymentUsdc) args.maxPaymentUsdc = values.maxPaymentUsdc;
    if (values.minEmergencyReserveUsdc) args.minEmergencyReserveUsdc = values.minEmergencyReserveUsdc;
    if (values.recipient) args.recipient = values.recipient;

    updateSettings({
      totalUsdc: values.availableUsdc,
      spendingUsdc: values.spendingAllocationUsdc,
      emergencyReserveUsdc: values.emergencyReserveUsdc,
      maxPaymentUsdc: values.maxPaymentUsdc,
      minEmergencyReserveUsdc: values.minEmergencyReserveUsdc,
      recipient: values.recipient,
    });

    setBusy(submit, true, "Checking…");
    result.innerHTML = `
      <div class="panel-body">
        <div class="inline small muted"><span class="spinner" aria-hidden="true"></span>Running check_payment_policy…</div>
        <div class="stack" style="margin-top:18px">
          <div class="skeleton" style="height:64px"></div>
          <div class="skeleton" style="height:14px"></div>
          <div class="skeleton" style="height:14px;width:78%"></div>
        </div>
      </div>`;

    try {
      const { result: toolResult, durationMs } = await callTool("check_payment_policy", args);

      if (toolResult?.isError === true) {
        const message = toolResult.content?.[0]?.text ?? "The plugin could not check this payment.";
        result.innerHTML = `
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Check failed</h2>
              <p class="panel-sub">${esc(durationMs)}ms</p>
            </div>
            ${decisionBadge("blocked")}
          </div>
          <div class="panel-body">
            ${alertBox("error", "The plugin rejected these inputs", `<span style="white-space:pre-line">${esc(message)}</span>`)}
            <div class="button-row" style="margin-top:14px">
              <button class="button" type="button" data-retry>Try again</button>
            </div>
          </div>`;
        addActivity({
          tool: "check_payment_policy",
          outcome: "error",
          summary: message.split("\n")[0],
          durationMs,
        });
        wireRetry(result, form);
        reveal(result);
        toast("The plugin rejected those inputs", { tone: "error" });
        return;
      }

      const structured = toolResult?.structuredContent;
      const policy = structured?.result;
      const decision = structured?.decision ?? policy?.decision;

      if (!policy || !decision) {
        result.innerHTML = alertBox("error", "Unexpected response", "The plugin returned no decision.");
        return;
      }

      result.innerHTML = policyResult(policy, durationMs);
      reveal(result);
      addActivity({
        tool: "check_payment_policy",
        outcome: decision,
        summary: `${money(policy.paymentAmountUsdc)} USDC payment · ${decision.replace("_", " ")}`,
        durationMs,
      });
      toast(`Decision: ${decision.replace("_", " ")}`, {
        tone: decision === "blocked" ? "error" : "default",
      });
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

function ruleRow(rule) {
  const glyph =
    rule.status === "pass"
      ? `<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.2 11.7 13 4.9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : rule.status === "fail"
        ? `<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`
        : `<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1.1" fill="currentColor"/></svg>`;

  return `
    <div class="rule" data-status="${esc(rule.status)}">
      <span class="rule-glyph" aria-hidden="true">${glyph}</span>
      <span class="rule-body">
        <span class="rule-name">
          ${esc(rule.rule.replaceAll("_", " "))}
          <span class="rule-severity">${esc(rule.severity)} rule</span>
        </span>
        <span class="rule-message">${esc(rule.message)}</span>
      </span>
    </div>`;
}

function policyResult(policy, durationMs) {
  const decision = policy.decision;
  const reasons =
    decision === "blocked" && policy.blockedBy.length
      ? `<p class="small" style="margin-top:14px;color:var(--block)">
           Blocked by: ${esc(policy.blockedBy.map((name) => name.replaceAll("_", " ")).join(", "))}
         </p>`
      : decision === "review_required" && policy.reviewReasons.length
        ? `<p class="small" style="margin-top:14px;color:var(--review)">
             Needs a look: ${esc(policy.reviewReasons.map((name) => name.replaceAll("_", " ")).join(", "))}
           </p>`
        : "";

  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Result</h2>
        <p class="panel-sub">${esc(durationMs)}ms · just returned by the plugin</p>
      </div>
      ${decisionBadge(decision)}
    </div>
    <div class="panel-body results-enter">
      ${decisionPanel(decision)}

      <div class="kv" style="margin-top:16px">
        <div class="kv-row">
          <div class="kv-key">Payment</div>
          <div class="kv-value">${esc(money(policy.paymentAmountUsdc))} USDC</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Spending left after this</div>
          <div class="kv-value">${esc(money(policy.remainingSpendingUsdc))} of ${esc(money(policy.spendingAllocationUsdc))} USDC</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Reserve after payment</div>
          <div class="kv-value">
            ${esc(money(policy.reserveAfterPaymentUsdc))} USDC
            <span class="faint"> · floor ${esc(money(policy.reserveFloorUsdc))}</span>
          </div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Available balance</div>
          <div class="kv-value">${esc(money(policy.availableUsdc))} USDC</div>
        </div>
      </div>

      ${reasons}

      <p class="eyebrow" style="margin:20px 0 4px">Rules evaluated</p>
      <div class="rules">
        ${policy.rules.map(ruleRow).join("")}
      </div>

      ${
        policy.explanation
          ? `<div class="divider" style="margin:16px 0 12px"></div>
             <p class="eyebrow">Plugin explanation</p>
             <p class="small muted" style="margin-top:6px;white-space:pre-line">${esc(policy.explanation)}</p>`
          : ""
      }
    </div>
    <div class="panel-foot">
      These are StablePilot's own rules, not PayBox limits. PayBox authorises payments separately.
    </div>`;
}
