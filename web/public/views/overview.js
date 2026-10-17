// Overview: the plan the plugin currently produces for the figures you entered.
//
// Both panels are real tool calls. Nothing on this page is a stored screenshot
// of an old result: if the plugin disagrees with the browser storage, the
// plugin wins.

import {
  alertBox,
  donut,
  emptyState,
  legend,
  outcomeBadge,
  pageHead,
  stackBar,
  TOOL_LABELS,
} from "../components/ui.js";
import { esc, icons } from "../lib/dom.js";
import { money, relative } from "../lib/format.js";
import {
  getActivity,
  getSettings,
  hasPlanFigures,
  planArguments,
  setLastPlan,
  setLastReport,
} from "../lib/store.js";
import { callTool } from "../lib/api.js";

const QUICK_ACTIONS = `
  <div class="quick-actions">
    <a class="quick-action" href="/planner">
      <span class="quick-icon" aria-hidden="true">${icons.plan}</span>
      <span class="quick-body">
        <span class="quick-title">Plan an allocation</span>
        <span class="quick-sub">Split a balance into spending, savings and reserve</span>
      </span>
    </a>
    <a class="quick-action" href="/checker">
      <span class="quick-icon" aria-hidden="true">${icons.shield}</span>
      <span class="quick-body">
        <span class="quick-title">Check a payment</span>
        <span class="quick-sub">Test an amount against your own policy rules</span>
      </span>
    </a>
    <a class="quick-action" href="/proposals">
      <span class="quick-icon" aria-hidden="true">${icons.send}</span>
      <span class="quick-body">
        <span class="quick-title">Prepare a proposal</span>
        <span class="quick-sub">Build an unsigned transfer for PayBox to authorise</span>
      </span>
    </a>
  </div>`;

function recentActivity(entries) {
  if (entries.length === 0) {
    return `<p class="small faint">No tool calls from this browser yet. Run a plan or a check and it appears here.</p>`;
  }
  return entries
    .map(
      (entry) => `
      <div class="activity-row">
        <span class="activity-time">${esc(relative(entry.at))}</span>
        <span class="activity-main">
          <span class="activity-tool">${esc(TOOL_LABELS[entry.tool] ?? entry.tool)}</span>
          <span class="activity-summary">${esc(entry.summary ?? "")}</span>
        </span>
        ${outcomeBadge(entry.outcome)}
      </div>`,
    )
    .join("");
}

function reportArguments(settings) {
  const args = {
    totalUsdc: String(settings.totalUsdc).trim(),
    spendingUsdc: String(settings.spendingUsdc).trim(),
    savingsUsdc: String(settings.savingsUsdc).trim(),
    emergencyReserveUsdc: String(settings.emergencyReserveUsdc).trim(),
  };
  const goal = String(settings.savingsGoalUsdc ?? "").trim();
  if (goal) args.savingsGoalUsdc = goal;
  return args;
}

function planPanel(plan) {
  return `
    <section class="panel" aria-labelledby="balance-title">
      <div class="panel-head">
        <div>
          <h2 class="panel-title" id="balance-title">Current allocation</h2>
          <p class="panel-sub">Returned by <code>plan_stablecoin_allocation</code></p>
        </div>
        <span class="badge" data-tone="neutral">Manual figures</span>
      </div>
      <div class="panel-body">
        <div class="balance">
          <span class="balance-label">Total USDC</span>
          <span class="balance-figure">
            <span class="balance-amount">${esc(money(plan.totalUsdc))}</span>
            <span class="balance-unit">USDC</span>
          </span>
          <span class="balance-note">
            ${icons.lock}
            You entered this figure. No wallet is connected and no on-chain balance is read.
          </span>
        </div>
        ${stackBar(plan.percentages)}
        ${legend(plan.percentages, plan)}
      </div>
      <div class="panel-foot between">
        <span>Total allocated: <strong>${esc(money(plan.totalAllocatedUsdc))} USDC</strong> of ${esc(money(plan.totalUsdc))}</span>
        <a class="button-link" href="/planner">Edit figures</a>
      </div>
    </section>`;
}

function sharePanel(plan, report) {
  const goal = plan.savingsGoal ?? {};
  const goalBlock = goal.provided
    ? (() => {
        const target = Number(goal.targetUsdc);
        const saved = Number(plan.savingsUsdc);
        const share = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
        return `
          <div class="divider" style="margin:18px 0 16px"></div>
          <div class="between">
            <span class="eyebrow">Savings goal</span>
            <span class="badge" data-tone="${goal.meetsGoal ? "allow" : "review"}">
              ${goal.meetsGoal ? "Met" : "Not met"}
            </span>
          </div>
          <p class="small" style="margin-top:8px">
            ${esc(money(plan.savingsUsdc))} of ${esc(money(goal.targetUsdc))} USDC
            ${goal.meetsGoal ? "" : `· short by <strong>${esc(money(goal.shortfallUsdc))} USDC</strong>`}
          </p>
          <div class="goal-track">
            <div class="goal-fill" data-met="${goal.meetsGoal}" style="width:${share.toFixed(1)}%"></div>
          </div>`;
      })()
    : `<p class="small faint" style="margin-top:14px">No savings goal set for this plan.</p>`;

  const guidance =
    report &&
    (report.inconsistencies.length > 0 || report.nextSteps.length > 0)
      ? `
        <div class="divider" style="margin:18px 0 16px"></div>
        <span class="eyebrow">From get_allocation_report</span>
        ${report.inconsistencies
          .map((line) => `<p class="small" style="margin-top:8px;color:var(--block)">${esc(line)}</p>`)
          .join("")}
        ${
          report.nextSteps.length
            ? `<ul class="small muted" style="margin:8px 0 0;padding-left:18px">${report.nextSteps
                .map((step) => `<li>${esc(step)}</li>`)
                .join("")}</ul>`
            : ""
        }`
      : "";

  return `
    <section class="panel" aria-labelledby="share-title">
      <div class="panel-head">
        <div>
          <h2 class="panel-title" id="share-title">Shares</h2>
          <p class="panel-sub">Percentages as calculated by the plugin</p>
        </div>
      </div>
      <div class="panel-body tight">
        ${donut(plan.percentages)}
        ${goalBlock}
        ${guidance}
      </div>
      ${
        plan.notes?.length
          ? `<div class="panel-foot">${plan.notes.map((note) => `<div>${esc(note)}</div>`).join("")}</div>`
          : ""
      }
    </section>`;
}

function errorPanel(message, { hint } = {}) {
  return `
    <section class="panel">
      <div class="panel-body">
        ${alertBox("error", "The plugin could not build a plan", esc(message))}
        <div class="button-row" style="margin-top:14px">
          <a class="button" href="/planner">Adjust the figures</a>
          <button class="button button-quiet" type="button" data-retry>Try again</button>
        </div>
        ${hint ? `<p class="small faint" style="margin-top:10px">${esc(hint)}</p>` : ""}
      </div>
    </section>`;
}

export async function render(root) {
  const settings = getSettings();
  const activity = getActivity().slice(0, 5);
  const ready = hasPlanFigures(settings);

  const actions = `
    <a class="button" href="/planner">${ready ? "Edit figures" : "Start a plan"}</a>
    <a class="button button-primary" href="/checker">Check a payment</a>`;

  root.innerHTML = `
    ${pageHead(
      "Overview",
      "Where your USDC is earmarked, calculated by the StablePilot plugin from the figures you entered.",
      actions,
    )}
    <div class="stack" id="overview-body"></div>`;

  const body = root.querySelector("#overview-body");

  if (!ready) {
    body.innerHTML = `
      <section class="panel">
        ${emptyState({
          title: "No plan yet",
          body: "Enter a total balance and how much to earmark for spending, savings and an emergency reserve. StablePilot returns the split, the percentages and whether your savings goal is met.",
          action: `<a class="button button-primary" href="/planner">Plan an allocation</a>`,
        })}
      </section>
      <div class="split">
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Quick actions</h2></div>
          <div class="panel-body tight">${QUICK_ACTIONS}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Recent activity</h2></div>
          <div class="panel-body">${recentActivity(activity)}</div>
        </section>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="split">
      <div class="skeleton" style="height:320px"></div>
      <div class="skeleton" style="height:320px"></div>
    </div>`;

  const [planCall, reportCall] = await Promise.allSettled([
    callTool("plan_stablecoin_allocation", planArguments(settings)),
    callTool("get_allocation_report", reportArguments(settings)),
  ]);

  const planResult = planCall.status === "fulfilled" ? planCall.value : null;
  const toolError = planResult?.result?.isError === true;
  const plan = planResult?.result?.structuredContent?.plan;

  if (!planResult || toolError || !plan) {
    const message =
      planResult?.result?.content?.[0]?.text ??
      (planCall.status === "rejected" ? planCall.reason?.message : "The tool returned no plan.");
    body.innerHTML = `
      ${errorPanel(message, {
        hint: "The figures are stored in this browser. Open the planner to correct them.",
      })}
      <div class="split">
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Quick actions</h2></div>
          <div class="panel-body tight">${QUICK_ACTIONS}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Recent activity</h2></div>
          <div class="panel-body">${recentActivity(activity)}</div>
        </section>
      </div>`;

    body.querySelector("[data-retry]")?.addEventListener("click", () => render(root));
    return;
  }

  const report =
    reportCall.status === "fulfilled" ? reportCall.value?.result?.structuredContent?.report : null;

  setLastPlan({ at: new Date().toISOString(), plan });
  if (report) setLastReport({ at: new Date().toISOString(), report });

  body.innerHTML = `
    <div class="split results-enter">
      ${planPanel(plan)}
      ${sharePanel(plan, report)}
    </div>
    <div class="split">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Recent activity</h2>
            <p class="panel-sub">Saved in this browser, not on-chain history</p>
          </div>
          <a class="button-link" href="/activity">View all</a>
        </div>
        <div class="panel-body">${recentActivity(activity)}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Quick actions</h2></div>
        <div class="panel-body tight">${QUICK_ACTIONS}</div>
      </section>
    </div>`;

}
