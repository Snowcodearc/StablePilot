// Smart Split markup. Pure functions of the data they are given, so the states
// can be tested without a browser.
//
// Wording rules enforced here and covered by tests:
//   * a plan is never described as a transfer, deposit or completed payment;
//   * the success state always says no funds have been moved;
//   * a failed tool call never looks like a confirmed plan.

import { esc, icons } from "../lib/dom.js";
import { money, pct } from "../lib/format.js";
import { CATEGORIES, MIN_USDC, SPLIT_PERCENT, TOOL } from "../lib/split.js";

function bar({ muted = false } = {}) {
  return `
    <div class="smart-bar${muted ? " is-muted" : ""}" role="img"
      aria-label="Allocation bar: ${SPLIT_PERCENT.spending}% spending, ${SPLIT_PERCENT.savings}% savings, ${SPLIT_PERCENT.reserve}% emergency reserve">
      ${CATEGORIES.map(
        (category) =>
          `<span class="smart-bar-seg" data-cat="${category.key}" style="width:${category.percent}%"></span>`,
      ).join("")}
    </div>`;
}

function cards(split) {
  return `
    <ul class="alloc-list">
      ${CATEGORIES.map((category) => {
        const amount = split?.ok ? split.amounts[category.key] : null;
        return `
        <li class="alloc-card" data-cat="${category.key}">
          <span class="alloc-head">
            <span class="alloc-dot" aria-hidden="true"></span>
            <span class="alloc-name">${esc(category.name)}</span>
          </span>
          <span class="alloc-figure">
            <span class="alloc-amount">
              ${amount === null ? "&mdash;" : esc(money(amount))}
              ${amount === null ? "" : `<span class="alloc-unit">USDC</span>`}
            </span>
            <span class="alloc-pct">${category.percent}%</span>
          </span>
          <span class="alloc-blurb">${esc(category.blurb)}</span>
        </li>`;
      }).join("")}
    </ul>`;
}

/**
 * The preview under the input.
 * `state` is "empty", "ready", "validated" or "unvalidated".
 */
export function previewHtml(split, { state = "empty" } = {}) {
  const ok = Boolean(split?.ok);
  const badge =
    state === "validated"
      ? `<span class="badge" data-tone="allow">${icons.check}Confirmed by plugin</span>`
      : state === "unvalidated"
        ? `<span class="badge" data-tone="review">${icons.bang}Not validated</span>`
        : `<span class="badge" data-tone="neutral">Live preview</span>`;

  return `
    <div class="smart-preview-head">
      <span class="eyebrow">Allocation preview</span>
      ${badge}
    </div>
    ${bar({ muted: !ok })}
    ${cards(split)}
    <div class="alloc-total">
      <span>Total allocated</span>
      <strong>${ok ? `${esc(money(split.input))} USDC` : "&mdash;"}</strong>
    </div>
    <p class="alloc-foot">
      ${
        ok
          ? `Unallocated <strong>0 USDC</strong>. The three parts add up to the amount you entered.`
          : `Enter at least ${esc(MIN_USDC)} USDC to see how it would be divided.`
      }
      ${
        state === "unvalidated"
          ? `<br /><span class="alloc-flag">This preview is arithmetic only. The plugin did not confirm it.</span>`
          : ""
      }
    </p>`;
}

/** The initial shell. `value` prefills the amount the user last confirmed. */
export function smartSplitShell({ value = "" } = {}) {
  return `
    <section class="smart-split" id="smart-split" aria-labelledby="smart-split-title">
      <div class="smart-split-copy">
        <span class="eyebrow">Smart Split</span>
        <h2 class="smart-split-title" id="smart-split-title">Give every dollar a purpose.</h2>
        <p class="smart-split-lead">
          Enter the USDC you want to allocate. StablePilot divides it
          ${SPLIT_PERCENT.spending}% spending, ${SPLIT_PERCENT.savings}% savings and
          ${SPLIT_PERCENT.reserve}% emergency reserve, then asks the plugin to confirm the plan.
          You get a plan, not a payment: nothing is moved, signed or sent.
        </p>
      </div>

      <div class="smart-split-body">
        <form class="smart-split-form" id="smart-split-form" novalidate>
          <label class="field-label" for="smart-split-amount">Amount to allocate</label>
          <div class="amount-hero">
            <input
              class="amount-hero-input"
              id="smart-split-amount"
              name="amountUsdc"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              placeholder="1000"
              value="${esc(value)}"
              aria-describedby="smart-split-hint smart-split-error"
            />
            <span class="amount-hero-unit">USDC</span>
          </div>
          <p class="field-hint" id="smart-split-hint">Minimum ${esc(MIN_USDC)} USDC.</p>
          <p class="field-error" id="smart-split-error" hidden></p>
          <button class="button button-primary smart-split-submit" id="smart-split-submit" type="submit">
            Generate allocation plan
          </button>
          <p class="smart-split-note">
            A plan is saved in this browser. No USDC is transferred, signed or sent, and no wallet is connected.
          </p>
        </form>

        <div class="smart-split-preview" id="smart-split-preview">
          ${previewHtml(null, { state: "empty" })}
        </div>
      </div>

      <div class="smart-split-result" id="smart-split-result"></div>
    </section>`;
}

/** Shown while the tool call is in flight. */
export function loadingHtml() {
  return `
    <div class="plan-pending" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <span>Calling <code>${esc(TOOL)}</code> to validate the split&hellip;</span>
    </div>`;
}

/**
 * The confirmed plan, rendered from the plugin's own response.
 * Never claims that money moved.
 */
export function successHtml(plan, { durationMs = null } = {}) {
  const parts = [
    ["Spending", plan.spendingUsdc, plan.percentages?.spending],
    ["Savings", plan.savingsUsdc, plan.percentages?.savings],
    ["Emergency reserve", plan.emergencyReserveUsdc, plan.percentages?.emergencyReserve],
  ];

  return `
    <div class="plan-done" role="status">
      <span class="plan-done-mark" aria-hidden="true">${icons.check}</span>
      <div class="plan-done-body">
        <p class="plan-done-title">Allocation plan generated. No funds have been moved.</p>
        <p class="plan-done-text">
          <code>${esc(TOOL)}</code> confirmed <strong>${esc(money(plan.totalUsdc))} USDC</strong>${durationMs ? ` in ${durationMs} ms` : ""}.
          Unallocated: <strong>${esc(money(plan.unallocatedUsdc))} USDC</strong>. The figures below come from the plugin's
          response, not from this page's arithmetic.
        </p>
        <dl class="plan-done-figures">
          ${parts
            .map(
              ([name, amount, percentage]) => `
            <div>
              <dt>${esc(name)}</dt>
              <dd>${esc(money(amount))} USDC <span class="faint">${esc(pct(percentage))}</span></dd>
            </div>`,
            )
            .join("")}
        </dl>
        ${
          plan.explanation
            ? `<details class="plan-done-note">
                <summary>Plugin explanation</summary>
                <p>${esc(plan.explanation)}</p>
              </details>`
            : ""
        }
        <p class="plan-done-fineprint">
          This is an allocation plan stored in this browser. It is not a transaction, a wallet balance or proof of funds,
          and it does not move USDC into separate accounts.
        </p>
        <div class="button-row">
          <button class="button" type="button" data-use-plan>Open in planner</button>
          <a class="button button-quiet" href="/checker">Check a payment</a>
        </div>
      </div>
    </div>`;
}

/**
 * Shown when the tool call fails. The local preview stays visible and is
 * relabelled "not validated" by the caller.
 */
export function failureHtml(message, { network = false } = {}) {
  const reason = String(message ?? "").trim() || "The plugin returned no explanation.";
  return `
    <div class="alert" data-tone="warn" role="alert">
      ${icons.info}
      <div class="alert-body">
        <div class="alert-title">The plugin could not validate this plan</div>
        <p>
          ${
            network
              ? "The StablePilot backend did not answer. Check that it is running, then try again."
              : "The plugin refused these figures. Nothing was saved."
          }
          Your preview above is local arithmetic only; it is not a confirmed plan.
        </p>
        <p class="alert-detail"><code>${esc(reason.split("\n")[0])}</code></p>
        <div class="button-row" style="margin-top:12px">
          <button class="button" type="button" data-retry>Try again</button>
        </div>
      </div>
    </div>`;
}
