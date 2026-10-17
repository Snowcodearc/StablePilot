// Allocation Planner.
//
// The form validates the plugin's own decimal grammar before sending, so typos
// are caught inline, but only the plugin decides the allocation: the result
// panel renders exactly what `plan_stablecoin_allocation` returned.

import { field, readFields, setBusy, setErrors, switchField } from "../components/fields.js";
import { alertBox, donut, emptyState, outcomeBadge, pageHead, reveal, stackBar } from "../components/ui.js";
import { esc } from "../lib/dom.js";
import { amount, amountError, dateTime, money, pct, sumAmounts } from "../lib/format.js";
import { callTool } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { addActivity, getLastPlan, getSettings, setLastPlan, updateSettings } from "../lib/store.js";

export async function render(root) {
  const settings = getSettings();

  root.innerHTML = `
    ${pageHead(
      "Allocation Planner",
      "Split a balance across spending, savings and an emergency reserve. The plugin returns the split, the percentages and whether your savings goal is met.",
    )}
    <div class="form-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Your figures</h2>
            <p class="panel-sub">Amounts are USDC, up to six decimal places</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form" id="plan-form" novalidate>
            <div class="form-grid">
              ${field({
                id: "totalUsdc",
                label: "Total USDC balance",
                hint: "The amount you have available. StablePilot cannot verify this.",
                value: settings.totalUsdc,
                placeholder: "1000",
                span: true,
              })}
              ${field({
                id: "spendingUsdc",
                label: "Spending",
                hint: "What you plan to spend from this balance.",
                value: settings.spendingUsdc,
                placeholder: "300",
              })}
              ${field({
                id: "savingsUsdc",
                label: "Savings",
                hint: "What you want to keep as savings.",
                value: settings.savingsUsdc,
                placeholder: "500",
              })}
              ${field({
                id: "emergencyReserveUsdc",
                label: "Emergency reserve",
                hint: "Held back and protected from normal payments.",
                value: settings.emergencyReserveUsdc,
                placeholder: "200",
              })}
              ${field({
                id: "savingsGoalUsdc",
                label: "Savings goal",
                hint: "Optional target to measure the savings allocation against.",
                value: settings.savingsGoalUsdc,
                placeholder: "600",
                optional: true,
              })}
              ${switchField({
                id: "explain",
                label: "Explain the result in plain language",
                hint: "Adds a written summary alongside the structured numbers.",
                checked: settings.explain !== false,
              })}
            </div>

            <div class="form-hint-box" id="sum-hint" hidden></div>

            <div class="button-row">
              <button class="button button-primary" type="submit" id="plan-submit">Plan allocation</button>
              <button class="button button-quiet" type="button" id="plan-reset">Clear form</button>
            </div>
            <p class="tiny faint">
              These figures are saved in this browser so the other screens can use them. They are never sent anywhere
              except to the local StablePilot backend.
            </p>
          </form>
        </div>
      </section>

      <section class="panel" id="plan-result" aria-live="polite"></section>
    </div>`;

  const form = root.querySelector("#plan-form");
  const resultPanel = root.querySelector("#plan-result");
  const submit = root.querySelector("#plan-submit");
  const sumHint = root.querySelector("#sum-hint");
  const stored = getLastPlan();

  if (stored?.plan) {
    resultPanel.innerHTML = planResult(stored.plan, { at: stored.at, stale: true });
  } else {
    resultPanel.innerHTML = emptyState({
      title: "Nothing planned yet",
      body: "Fill in the four amounts and run the tool. The breakdown, percentages, savings-goal check and the plugin's own notes appear here.",
    });
  }

  /** Local arithmetic only, to warn about an obvious sum overflow before a call. */
  function updateSumHint() {
    const values = readFields(form);
    const total = values.totalUsdc;
    const parts = [values.spendingUsdc, values.savingsUsdc, values.emergencyReserveUsdc];
    const summed = sumAmounts(parts);

    if (summed === null || !total) {
      sumHint.hidden = true;
      return;
    }

    const over = sumAmounts([total]) !== null && Number(summed) > Number(total);
    sumHint.hidden = false;
    sumHint.innerHTML = over
      ? `<strong>Local check:</strong> the three amounts add up to ${esc(amount(summed))}, which is more than the ${esc(amount(total))} total. The plugin will refuse this.`
      : `<strong>Local check:</strong> the three amounts add up to ${esc(amount(summed))} of ${esc(amount(total))}. The plugin decides the final split.`;
    sumHint.style.borderColor = over ? "var(--block)" : "var(--rule)";
    sumHint.style.background = over ? "var(--block-wash)" : "var(--surface-sunk)";
  }

  form.addEventListener("input", updateSumHint);
  updateSumHint();

  root.querySelector("#plan-reset").addEventListener("click", () => {
    form.reset();
    setErrors(form, {});
    updateSumHint();
    form.querySelector("#totalUsdc")?.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = readFields(form);

    const errors = {
      totalUsdc: amountError(values.totalUsdc, { label: "Total balance" }),
      spendingUsdc: amountError(values.spendingUsdc, { label: "Spending amount" }),
      savingsUsdc: amountError(values.savingsUsdc, { label: "Savings amount" }),
      emergencyReserveUsdc: amountError(values.emergencyReserveUsdc, { label: "Emergency reserve" }),
      savingsGoalUsdc: amountError(values.savingsGoalUsdc, { label: "Savings goal", required: false }),
    };

    if (setErrors(form, errors)) {
      resultPanel.innerHTML = alertBox(
        "warn",
        "Some amounts need fixing",
        "Correct the highlighted fields and run the tool again. Nothing was sent.",
      );
      return;
    }

    updateSettings({
      totalUsdc: values.totalUsdc,
      spendingUsdc: values.spendingUsdc,
      savingsUsdc: values.savingsUsdc,
      emergencyReserveUsdc: values.emergencyReserveUsdc,
      savingsGoalUsdc: values.savingsGoalUsdc,
      explain: values.explain,
    });

    const args = {
      totalUsdc: values.totalUsdc,
      spendingUsdc: values.spendingUsdc,
      savingsUsdc: values.savingsUsdc,
      emergencyReserveUsdc: values.emergencyReserveUsdc,
    };
    if (values.savingsGoalUsdc) args.savingsGoalUsdc = values.savingsGoalUsdc;
    if (values.explain === false) args.explain = false;

    setBusy(submit, true, "Planning…");
    resultPanel.innerHTML = loadingBlock("Running plan_stablecoin_allocation…");

    try {
      const response = await callTool("plan_stablecoin_allocation", args);
      const { result, durationMs } = response;

      if (result?.isError === true) {
        const message = result.content?.[0]?.text ?? "The plugin refused this allocation.";
        resultPanel.innerHTML = refusalBlock(message, durationMs);
        reveal(resultPanel);
        addActivity({
          tool: "plan_stablecoin_allocation",
          outcome: "error",
          summary: message.split("\n")[0],
          durationMs,
        });
        toast("The plugin refused that allocation", { tone: "error" });
        wireRetry(resultPanel, form);
        return;
      }

      const plan = result?.structuredContent?.plan;
      if (!plan) {
        resultPanel.innerHTML = refusalBlock("The plugin returned no plan.", durationMs);
        return;
      }

      setLastPlan({ at: new Date().toISOString(), plan });
      resultPanel.innerHTML = planResult(plan, { at: new Date().toISOString(), durationMs });
      reveal(resultPanel);
      addActivity({
        tool: "plan_stablecoin_allocation",
        outcome: "planned",
        summary: `${amount(plan.totalUsdc)} split ${pct(plan.percentages.spending)} spending, ${pct(plan.percentages.savings)} savings, ${pct(plan.percentages.emergencyReserve)} reserve`,
        durationMs,
      });
      toast(`Plan built in ${durationMs}ms`);
    } catch (error) {
      resultPanel.innerHTML = transportError(error);
      reveal(resultPanel);
      wireRetry(resultPanel, form);
      toast("Could not reach the plugin", { tone: "error" });
    } finally {
      setBusy(submit, false);
    }
  });
}

function loadingBlock(message) {
  return `
    <div class="panel-body">
      <div class="inline small muted"><span class="spinner" aria-hidden="true"></span>${esc(message)}</div>
      <div class="stack" style="margin-top:18px">
        <div class="skeleton" style="height:56px"></div>
        <div class="skeleton" style="height:14px"></div>
        <div class="skeleton" style="height:14px;width:80%"></div>
        <div class="skeleton" style="height:14px;width:64%"></div>
      </div>
    </div>`;
}

function refusalBlock(message, durationMs) {
  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Refused by the plugin</h2>
        <p class="panel-sub">${esc(durationMs)}ms · no plan was produced</p>
      </div>
      ${outcomeBadge("error")}
    </div>
    <div class="panel-body">
      ${alertBox("error", "This allocation was rejected", `<span style="white-space:pre-line">${esc(message)}</span>`)}
      <div class="button-row" style="margin-top:14px">
        <button class="button" type="button" data-retry>Try again</button>
      </div>
    </div>`;
}

function transportError(error) {
  return `
    <div class="panel-head"><h2 class="panel-title">Could not run the tool</h2></div>
    <div class="panel-body">
      ${alertBox("error", "Request failed", esc(error?.message ?? String(error)))}
      <div class="button-row" style="margin-top:14px">
        <button class="button" type="button" data-retry>Try again</button>
      </div>
    </div>`;
}

function wireRetry(panel, form) {
  panel.querySelector("[data-retry]")?.addEventListener("click", () => {
    form.requestSubmit();
  });
}

function planResult(plan, { at, durationMs = null, stale = false } = {}) {
  const goal = plan.savingsGoal ?? {};
  const rows = [
    ["Spending", plan.spendingUsdc, plan.percentages.spending],
    ["Savings", plan.savingsUsdc, plan.percentages.savings],
    ["Emergency reserve", plan.emergencyReserveUsdc, plan.percentages.emergencyReserve],
  ];

  const goalBlock = goal.provided
    ? (() => {
        const target = Number(goal.targetUsdc);
        const saved = Number(plan.savingsUsdc);
        const share = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
        return `
          <div class="between" style="margin-top:18px">
            <span class="eyebrow">Savings goal</span>
            <span class="badge" data-tone="${goal.meetsGoal ? "allow" : "review"}">
              ${goal.meetsGoal ? "Goal met" : "Goal not met"}
            </span>
          </div>
          <p class="small muted" style="margin-top:6px">
            ${esc(money(plan.savingsUsdc))} of ${esc(money(goal.targetUsdc))} USDC${
              goal.meetsGoal ? "" : ` · short by <strong style="color:var(--ink)">${esc(money(goal.shortfallUsdc))} USDC</strong>`
            }
          </p>
          <div class="goal-track"><div class="goal-fill" data-met="${goal.meetsGoal}" style="width:${share.toFixed(1)}%"></div></div>`;
      })()
    : `<p class="small faint" style="margin-top:16px">No savings goal was supplied, so no goal check was made.</p>`;

  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">${stale ? "Result from earlier" : "Allocation plan"}</h2>
        <p class="panel-sub">
          ${stale ? `Stored in this browser · ${esc(dateTime(at))}` : `${esc(durationMs)}ms · just returned by the plugin`}
        </p>
      </div>
      ${outcomeBadge("planned")}
    </div>
    <div class="panel-body results-enter">
      <div class="between">
        <span class="balance-label">Total allocated</span>
        <span class="num" style="font-size:1.375rem;font-weight:600">
          ${esc(money(plan.totalAllocatedUsdc))}
          <span class="small muted">of ${esc(money(plan.totalUsdc))} USDC</span>
        </span>
      </div>
      ${stackBar(plan.percentages)}

      <table class="ledger" style="margin-top:18px">
        <thead>
          <tr><th scope="col">Category</th><th scope="col" class="right">Amount</th><th scope="col" class="right">Share</th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              ([name, value, share]) => `
            <tr>
              <td>${esc(name)}</td>
              <td class="right ledger-amount">${esc(money(value))}</td>
              <td class="right muted">${esc(pct(share))}</td>
            </tr>`,
            )
            .join("")}
          <tr class="total-row">
            <td>Unallocated</td>
            <td class="right">${esc(money(plan.unallocatedUsdc))}</td>
            <td class="right">${esc(pct(plan.percentages.unallocated))}</td>
          </tr>
        </tbody>
      </table>

      ${donut(plan.percentages)}
      ${goalBlock}

      ${
        plan.notes?.length
          ? `<div class="divider" style="margin:18px 0 12px"></div>
             <ul class="small muted" style="margin:0;padding-left:18px">
               ${plan.notes.map((note) => `<li>${esc(note)}</li>`).join("")}
             </ul>`
          : ""
      }

      ${
        plan.explanation
          ? `<div class="divider" style="margin:16px 0 12px"></div>
             <p class="eyebrow">Plugin explanation</p>
             <p class="small muted" style="margin-top:6px;white-space:pre-line">${esc(plan.explanation)}</p>`
          : ""
      }
    </div>
    <div class="panel-foot">
      <div class="button-row">
        <a class="button" href="/checker">Check a payment against this plan</a>
        <a class="button button-quiet" href="/proposals">Prepare a proposal</a>
      </div>
    </div>`;
}
