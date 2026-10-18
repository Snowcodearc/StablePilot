// What-If Simulator.
//
// Read-only by construction: the only plugin calls are the allocation plan and
// the policy check. There is no proposal call, no signing and no transaction.
// Figures the plugin returns are labelled as plugin results; the remaining
// balance is labelled as a local estimate.

import { field, readFields, setBusy, setErrors } from "../components/fields.js";
import {
  alertBox,
  decisionBadge,
  decisionPanel,
  emptyState,
  pageHead,
  reveal,
} from "../components/ui.js";
import { esc, icons } from "../lib/dom.js";
import { amount, dateTime, money } from "../lib/format.js";
import { callTool } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { getSettings, addActivity } from "../lib/store.js";
import {
  PLAN_TOOL,
  POLICY_TOOL,
  hasErrors,
  impactSummary,
  runSimulation,
  validateSimulation,
} from "../lib/simulate.js";

export const SIMULATION_NOTICE = "Simulation only. No funds have been moved.";

const DECISION_LABEL = {
  allowed: "Allowed",
  blocked: "Blocked",
  review_required: "Review required",
};

export function simulatorShell(settings) {
  return `
    ${pageHead(
      "What-If Simulator",
      "Preview a hypothetical USDC purchase against your allocation and payment policy. Nothing is sent, signed or proposed.",
    )}

    ${alertBox(
      "info",
      SIMULATION_NOTICE,
      "This screen only asks the plugin to plan and check the figures you type. It cannot create a payment proposal or move money.",
    )}

    <div class="form-layout" style="margin-top:20px">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Hypothetical purchase</h2>
            <p class="panel-sub">Prefilled from your saved figures</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form" id="simulate-form" novalidate>
            <div class="form-grid">
              ${field({
                id: "purchaseAmountUsdc",
                label: "Purchase amount",
                hint: "The hypothetical amount to test. It is never sent as a payment.",
                value: "",
                placeholder: "150",
                span: true,
              })}
              ${field({
                id: "description",
                label: "Purchase description or merchant",
                hint: "Optional. Shown in the summary only; it is not used as a payment recipient.",
                value: "",
                suffix: "",
                inputmode: "text",
                placeholder: "e.g. Hardware wallet",
                optional: true,
                span: true,
              })}
            </div>

            <p class="eyebrow" style="margin:20px 0 2px">Current figures</p>
            <p class="small faint" style="margin:0 0 12px">
              These are the figures you supplied. They are not a verified on-chain balance.
            </p>

            <div class="form-grid">
              ${field({
                id: "availableUsdc",
                label: "Available balance (user-provided)",
                hint: "The total USDC you say you hold. StablePilot cannot verify this.",
                value: settings.totalUsdc,
                placeholder: "1000",
                span: true,
              })}
              ${field({
                id: "spendingUsdc",
                label: "Spending allocation",
                hint: "The spending budget from your plan.",
                value: settings.spendingUsdc,
                placeholder: "300",
              })}
              ${field({
                id: "savingsUsdc",
                label: "Savings allocation",
                hint: "Held as savings by your plan; a purchase does not spend it.",
                value: settings.savingsUsdc,
                placeholder: "500",
              })}
              ${field({
                id: "emergencyReserveUsdc",
                label: "Emergency reserve",
                hint: "The reserve the policy checks against.",
                value: settings.emergencyReserveUsdc,
                placeholder: "200",
              })}
              ${field({
                id: "savingsGoalUsdc",
                label: "Savings goal",
                hint: "Optional. Without it, goal progress is not shown.",
                value: settings.savingsGoalUsdc,
                placeholder: "600",
                optional: true,
              })}
              ${field({
                id: "maxPaymentUsdc",
                label: "Maximum per payment",
                hint: "Without a limit the plugin returns review required.",
                value: settings.maxPaymentUsdc,
                placeholder: "100",
                optional: true,
              })}
              ${field({
                id: "minEmergencyReserveUsdc",
                label: "Reserve floor",
                hint: "Optional explicit floor, overriding the reserve allocation.",
                value: settings.minEmergencyReserveUsdc,
                optional: true,
                span: true,
              })}
            </div>

            <div class="button-row">
              <button class="button button-primary" type="submit" id="simulate-submit">Run simulation</button>
            </div>
            <p class="tiny faint">
              Adjust the purchase amount and run again without reloading. Saved preferences are used as defaults and
              are not changed by a simulation.
            </p>
          </form>
        </div>
      </section>

      <section class="panel" id="simulate-result" aria-live="polite">
        ${emptyState({
          title: "Nothing simulated yet",
          body: "Enter a hypothetical purchase and run the simulation. You will see the plugin's allocation, the plugin's policy verdict, and a clearly labelled estimate of your balance afterwards.",
        })}
      </section>
    </div>`;
}

function sourceTag(kind) {
  return kind === "plugin"
    ? `<span class="source-tag" data-source="plugin">Plugin</span>`
    : `<span class="source-tag" data-source="estimate">Estimate</span>`;
}

function simRow(metric, before, after, source) {
  return `
    <div class="sim-row">
      <span class="sim-metric">${esc(metric)}</span>
      <span class="sim-before"><span class="sim-mobile-label">Before</span>${before}</span>
      <span class="sim-after"><span class="sim-mobile-label">After</span>${after}</span>
      <span class="sim-source">${source}</span>
    </div>`;
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

function missingNotes(result) {
  const notes = [];
  if (result.preview.savingsGoal.provided !== true) {
    notes.push(
      "Savings goal: not supplied. Goal progress after the purchase is not shown rather than estimated.",
    );
  }
  if (!result.policy.rules.some((rule) => rule.rule === "per_payment_limit" && rule.status !== "unknown")) {
    notes.push(
      "Maximum per payment: not supplied. The plugin cannot clear that rule, which is why a review-required verdict is possible.",
    );
  }
  if (result.plan.unallocatedUsdc && result.plan.unallocatedUsdc !== "0") {
    notes.push(
      `${money(result.plan.unallocatedUsdc)} USDC of your balance is unallocated in the plugin's plan. ` +
        "The policy figures below use the plugin's allocation, not an assumption about that remainder.",
    );
  }
  return notes;
}

export function renderSimulation(outcome) {
  const { preview, policy, plan } = outcome;
  const goal = preview.savingsGoal;
  const goalProvided = goal.provided === true;
  const decision = policy.decision;
  const over = preview.overSpending !== "0";

  const limitLine = over
    ? `Over your ${amount(preview.spendingBefore)} spending allocation by ${amount(preview.overSpending)}.`
    : `Within your ${amount(preview.spendingBefore)} spending allocation, with ${amount(preview.spendingHeadroom)} unused.`;

  const goalRow = goalProvided
    ? simRow(
        "Savings goal",
        `${amount(goal.targetUsdc)} target`,
        goal.meetsGoal
          ? "Met at the planned savings amount"
          : `Short by ${amount(goal.shortfallUsdc)}`,
        sourceTag("plugin"),
      )
    : "";

  const notes = missingNotes(outcome);

  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Simulation result</h2>
        <p class="panel-sub">
          ${esc(dateTime(outcome.at))} · allocation and policy returned by the plugin
        </p>
      </div>
      ${decisionBadge(decision)}
    </div>
    <div class="panel-body results-enter">
      ${decisionPanel(decision)}

      <p class="sim-summary">${esc(impactSummary(outcome))}</p>

      <p class="eyebrow" style="margin:20px 0 8px">Before and after</p>
      <div class="sim-table" role="table" aria-label="Current and simulated financial position">
        <div class="sim-row sim-head" role="row">
          <span>Measure</span><span>Before</span><span>After</span><span>Source</span>
        </div>
        ${simRow(
          "Available balance (total)",
          `${amount(preview.balanceBefore)}`,
          `${amount(preview.balanceAfter)}`,
          sourceTag("estimate"),
        )}
        ${simRow(
          "Spending allocation (spendable)",
          `${amount(preview.spendingBefore)}`,
          `${amount(preview.spendingAfter)}`,
          sourceTag("plugin"),
        )}
        ${simRow(
          "Savings allocation",
          `${amount(preview.savingsBefore)}`,
          `${amount(preview.savingsAfter)} <span class="faint">unchanged</span>`,
          sourceTag("plugin"),
        )}
        ${simRow(
          "Emergency reserve",
          `${amount(preview.reserveBefore)} floor`,
          `${amount(preview.reserveAfter)} <span class="faint">unchanged</span>`,
          sourceTag("plugin"),
        )}
        ${simRow(
          "Balance after payment vs. reserve floor",
          `<span class="faint">not checked</span>`,
          `${amount(preview.reserveBalanceAfter)} left · floor ${amount(preview.reserveFloor)}`,
          sourceTag("plugin"),
        )}
        ${simRow(
          "Policy verdict",
          `<span class="faint">not checked</span>`,
          esc(DECISION_LABEL[decision] ?? decision),
          sourceTag("plugin"),
        )}
        ${goalRow}
      </div>

      <div class="sim-limit" data-tone="${over ? "over" : "within"}">
        ${icons.info}
        <span><strong>${esc(over ? "Over the spending limit" : "Within the spending limit")}.</strong> ${esc(limitLine)}
          This comparison is local arithmetic on the plugin's allocation and the amount you typed.</span>
      </div>

      <p class="eyebrow" style="margin:20px 0 4px">Policy rules evaluated</p>
      <div class="rules">
        ${policy.rules.map(ruleRow).join("")}
      </div>

      <div class="divider" style="margin:16px 0 12px"></div>
      <p class="eyebrow">How to read this</p>
      <ul class="sim-notes">
        <li><strong>Available balance</strong> is total funds from the balance you supplied. The post-purchase figure is an estimate: starting balance minus purchase amount.</li>
        <li><strong>Spending, savings and reserve</strong> are the plugin's plan and policy figures. The plugin decides the allocation and the verdict. The reserve is a floor, so it is shown unchanged; the policy result separately reports the balance left against that floor.</li>
        <li>The allocation model does not spend savings for a purchase, so savings is shown unchanged. The simulator does not move funds between categories.</li>
        ${goalProvided ? "" : "<li>No savings goal was supplied, so no goal progress is claimed.</li>"}
        ${notes.map((note) => `<li>${esc(note)}</li>`).join("")}
      </ul>

      ${
        policy.explanation
          ? `<div class="divider" style="margin:16px 0 12px"></div>
             <p class="eyebrow">Plugin explanation</p>
             <p class="small muted" style="margin-top:6px;white-space:pre-line">${esc(policy.explanation)}</p>`
          : ""
      }
    </div>
    <div class="panel-foot">
      ${SIMULATION_NOTICE} No payment proposal was created, and no transaction hash exists for a simulation.
    </div>`;
}

export function renderIncomplete(outcome) {
  const stage =
    outcome.stage === "plan_stablecoin_allocation"
      ? "The allocation tool could not complete a plan."
      : "The policy tool could not complete its check.";
  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Simulation incomplete</h2>
        <p class="panel-sub">No verdict was produced</p>
      </div>
      <span class="badge" data-tone="neutral">Incomplete</span>
    </div>
    <div class="panel-body">
      ${alertBox("warn", "Not enough to finish the simulation", esc(outcome.message))}
      <p class="small muted" style="margin-top:12px;white-space:pre-line">${esc(stage)}</p>
      <p class="small faint" style="margin-top:6px">
        Check the figures above, especially the allocation amounts and the optional limits. Nothing was sent, and no
        result has been invented to fill the gap.
      </p>
      <div class="button-row" style="margin-top:14px">
        <button class="button" type="button" data-retry>Try again</button>
      </div>
    </div>
    <div class="panel-foot">${SIMULATION_NOTICE}</div>`;
}

export function renderToolError(outcome) {
  const message = outcome.error?.message ?? String(outcome.error ?? "The request failed.");
  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Could not run the simulation</h2>
        <p class="panel-sub">${esc(outcome.stage ?? "Tool error")}</p>
      </div>
      <span class="badge" data-tone="block">Error</span>
    </div>
    <div class="panel-body">
      ${alertBox("error", "Request failed", esc(message))}
      <p class="small faint" style="margin-top:10px">
        A failed tool call is not a successful simulation. No funds were moved and no proposal was created.
      </p>
      <div class="button-row" style="margin-top:14px">
        <button class="button" type="button" data-retry>Try again</button>
      </div>
    </div>
    <div class="panel-foot">${SIMULATION_NOTICE}</div>`;
}

export function renderInvalid() {
  return alertBox(
    "warn",
    "Some fields need fixing",
    "Correct the highlighted fields and run the simulation again. Nothing was sent.",
  );
}

function renderLoading() {
  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Simulating</h2>
        <p class="panel-sub">Running the plugin's allocation and policy tools</p>
      </div>
    </div>
    <div class="panel-body">
      <div class="inline small muted"><span class="spinner" aria-hidden="true"></span>Planning, then checking the policy…</div>
      <div class="stack" style="margin-top:18px">
        <div class="skeleton" style="height:64px"></div>
        <div class="skeleton" style="height:14px"></div>
        <div class="skeleton" style="height:14px;width:78%"></div>
      </div>
    </div>`;
}

function wireRetry(panel, form) {
  panel.querySelector("[data-retry]")?.addEventListener("click", () => form.requestSubmit());
}

/**
 * The local activity log records tool calls, not payments. A simulation adds
 * only these two entries; it never writes settings, balances or proposal state.
 */
function logOutcome(outcome, values) {
  if (outcome.status === "ok") {
    addActivity({
      tool: PLAN_TOOL,
      outcome: "planned",
      summary: `${amount(outcome.plan.totalUsdc)} allocation · what-if simulation`,
      durationMs: outcome.planDurationMs,
    });
    addActivity({
      tool: POLICY_TOOL,
      outcome: outcome.decision,
      summary: `${amount(values.purchaseAmountUsdc)} hypothetical purchase · ${outcome.decision.replace("_", " ")}`,
      durationMs: outcome.policyDurationMs,
    });
    return;
  }

  if (outcome.status === "incomplete") {
    if (outcome.stage === POLICY_TOOL && outcome.plan) {
      addActivity({
        tool: PLAN_TOOL,
        outcome: "planned",
        summary: `${amount(outcome.plan.totalUsdc)} allocation · what-if simulation`,
      });
    }
    addActivity({
      tool: outcome.stage ?? PLAN_TOOL,
      outcome: "error",
      summary: String(outcome.message ?? "Simulation incomplete").split("\n")[0],
    });
    return;
  }

  if (outcome.status === "error") {
    addActivity({
      tool: outcome.stage ?? PLAN_TOOL,
      outcome: "error",
      summary: String(outcome.error?.message ?? "Simulation failed").split("\n")[0],
    });
  }
}

export async function render(root) {
  const settings = getSettings();
  root.innerHTML = simulatorShell(settings);

  const form = root.querySelector("#simulate-form");
  const result = root.querySelector("#simulate-result");
  const submit = root.querySelector("#simulate-submit");
  let inFlight = false;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (inFlight) return;

    const values = readFields(form);
    const errors = validateSimulation(values);
    if (setErrors(form, errors) || hasErrors(errors)) {
      result.innerHTML = renderInvalid();
      return;
    }

    inFlight = true;
    setBusy(submit, true, "Simulating…");
    result.innerHTML = renderLoading();

    try {
      const outcome = await runSimulation(values, callTool);

      if (outcome.status === "invalid") {
        setErrors(form, outcome.errors);
        result.innerHTML = renderInvalid();
        return;
      }

      if (outcome.status === "incomplete") {
        logOutcome(outcome, values);
        result.innerHTML = renderIncomplete(outcome);
        wireRetry(result, form);
        reveal(result);
        toast("Simulation incomplete", { tone: "default" });
        return;
      }

      if (outcome.status === "error") {
        logOutcome(outcome, values);
        result.innerHTML = renderToolError(outcome);
        wireRetry(result, form);
        reveal(result);
        toast("The simulation could not run", { tone: "error" });
        return;
      }

      logOutcome(outcome, values);
      result.innerHTML = renderSimulation(outcome);
      reveal(result);
      toast(
        outcome.decision === "blocked"
          ? "Policy blocked this purchase"
          : outcome.decision === "review_required"
            ? "Policy review required"
            : "Simulation complete",
        { tone: outcome.decision === "blocked" ? "error" : "default" },
      );
    } catch (error) {
      addActivity({
        tool: "what_if_simulation",
        outcome: "error",
        summary: String(error?.message ?? "Simulation failed").split("\n")[0],
      });
      result.innerHTML = renderToolError({ error, stage: "Unexpected error" });
      wireRetry(result, form);
      reveal(result);
    } finally {
      inFlight = false;
      setBusy(submit, false);
    }
  });
}
