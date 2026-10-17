// Activity History.
//
// This is a log of what this browser asked the plugin to do. It is not
// blockchain history and not PayBox history, and the page says so.

import { emptyState, outcomeBadge, pageHead, TOOL_LABELS } from "../components/ui.js";
import { esc } from "../lib/dom.js";
import { dateTime, relative } from "../lib/format.js";
import { clearActivity, getActivity } from "../lib/store.js";
import { toast } from "../lib/toast.js";

const FILTERS = [
  { id: "all", label: "All", match: () => true },
  { id: "plan", label: "Allocation plans", match: (e) => e.tool === "plan_stablecoin_allocation" },
  { id: "check", label: "Payment checks", match: (e) => e.tool === "check_payment_policy" },
  { id: "proposal", label: "Proposals", match: (e) => e.tool === "propose_usdc_payment" },
];

let activeFilter = "all";

export async function render(root) {
  const entries = getActivity();

  root.innerHTML = `
    ${pageHead(
      "Activity History",
      "Every tool call made from this browser, newest first. Saved locally, so it survives a refresh but not a cleared browser.",
    )}
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">${entries.length} ${entries.length === 1 ? "entry" : "entries"}</h2>
          <p class="panel-sub">Local UI history · not blockchain or PayBox transaction history</p>
        </div>
        <div class="button-row">
          <button class="button button-quiet" type="button" id="export" ${entries.length ? "" : "disabled"}>
            Download JSON
          </button>
          <button class="button button-quiet" type="button" id="clear" ${entries.length ? "" : "disabled"}>
            Clear history
          </button>
        </div>
      </div>
      ${
        entries.length
          ? `<div class="filters" role="tablist" aria-label="Filter activity">
               ${FILTERS.map(
                 (filter) => `
                 <button class="chip" type="button" role="tab" data-filter="${filter.id}"
                   aria-selected="${filter.id === activeFilter}">
                   ${esc(filter.label)}
                 </button>`,
               ).join("")}
             </div>`
          : ""
      }
      <div class="panel-body" id="activity-list">
        ${
          entries.length
            ? renderList(entries)
            : emptyState({
                title: "Nothing recorded yet",
                body: "Run an allocation plan, a payment check or a proposal build and each call is logged here with its outcome and timing.",
                action: `<a class="button button-primary" href="/planner">Plan an allocation</a>`,
              })
        }
      </div>
      <div class="panel-foot">
        Outcomes are recorded as returned by the plugin. A blocked or refused call stays blocked or refused here.
      </div>
    </section>`;

  const list = root.querySelector("#activity-list");

  for (const chip of root.querySelectorAll("[data-filter]")) {
    chip.addEventListener("click", () => {
      activeFilter = chip.dataset.filter;
      for (const other of root.querySelectorAll("[data-filter]")) {
        other.setAttribute("aria-selected", String(other.dataset.filter === activeFilter));
      }
      const filter = FILTERS.find((item) => item.id === activeFilter);
      list.innerHTML = renderList(entries.filter(filter.match));
    });
  }

  root.querySelector("#export")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stablepilot-activity-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast("Activity downloaded");
  });

  const clear = root.querySelector("#clear");
  clear?.addEventListener("click", () => {
    if (clear.dataset.armed !== "true") {
      clear.dataset.armed = "true";
      clear.textContent = "Tap again to confirm";
      clear.dataset.tone = "danger";
      setTimeout(() => {
        if (!clear.isConnected) return;
        clear.dataset.armed = "false";
        clear.textContent = "Clear history";
        clear.removeAttribute("data-tone");
      }, 4000);
      return;
    }
    clearActivity();
    toast("Activity history cleared");
    render(root);
  });
}

function renderList(entries) {
  if (entries.length === 0) {
    return `<p class="small faint">No entries match this filter.</p>`;
  }

  const groups = new Map();
  for (const entry of entries) {
    const key = dayKey(entry.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  return [...groups.entries()]
    .map(
      ([key, rows]) => `
      <div class="day-group">
        <p class="eyebrow">${esc(key)}</p>
        ${rows
          .map(
            (entry) => `
          <div class="activity-row">
            <span class="activity-time" title="${esc(dateTime(entry.at))}">${esc(relative(entry.at))}</span>
            <span class="activity-main">
              <span class="activity-tool">${esc(TOOL_LABELS[entry.tool] ?? entry.tool)}</span>
              <span class="activity-summary">${esc(entry.summary ?? "")}</span>
            </span>
            <span class="activity-end">
              <span class="activity-duration faint num">${entry.durationMs ? `${esc(entry.durationMs)}ms` : ""}</span>
              ${outcomeBadge(entry.outcome)}
            </span>
          </div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");
}

function dayKey(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}
