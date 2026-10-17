// Shared presentational pieces: charts, status marks, small layout helpers.
// Everything here returns an HTML string and escapes its inputs.

import { esc, icons } from "../lib/dom.js";
import { money, pct } from "../lib/format.js";

export const DECISION = {
  allowed: {
    tone: "allow",
    label: "Allowed",
    icon: icons.check,
    sub: "Every rule you supplied passed.",
  },
  blocked: {
    tone: "block",
    label: "Blocked",
    icon: icons.cross,
    sub: "A hard rule failed, so this payment is refused.",
  },
  review_required: {
    tone: "review",
    label: "Review required",
    icon: icons.bang,
    sub: "No hard rule failed, but something needs a human decision.",
  },
};

export function decisionBadge(decision) {
  const meta = DECISION[decision];
  if (!meta) return `<span class="badge" data-tone="neutral">${esc(decision ?? "unknown")}</span>`;
  return `<span class="badge" data-tone="${meta.tone}">${meta.icon}${meta.label}</span>`;
}

/** The large verdict block at the top of a checker or proposal result. */
export function decisionPanel(decision, sub) {
  const meta = DECISION[decision];
  if (!meta) return "";
  return `
    <div class="decision" data-decision="${esc(decision)}">
      <div class="decision-mark" aria-hidden="true">${meta.icon}</div>
      <div class="decision-text">
        <div class="decision-label">${meta.label}</div>
        <div class="decision-sub">${esc(sub ?? meta.sub)}</div>
      </div>
    </div>`;
}

export function pageHead(title, subtitle, actions = "") {
  return `
    <div class="page-head">
      <div>
        <h1>${esc(title)}</h1>
        <p class="page-sub">${esc(subtitle)}</p>
      </div>
      ${actions ? `<div class="button-row">${actions}</div>` : ""}
    </div>`;
}

export function alertBox(tone, title, body) {
  return `
    <div class="alert" data-tone="${esc(tone)}" role="${tone === "error" ? "alert" : "status"}">
      ${icons.info}
      <div class="alert-body">
        ${title ? `<div class="alert-title">${esc(title)}</div>` : ""}
        <div>${body}</div>
      </div>
    </div>`;
}

export function emptyState({ title, body, action = "" }) {
  return `
    <div class="empty">
      <div class="empty-mark" aria-hidden="true">${icons.plan}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(body)}</p>
      ${action}
    </div>`;
}

/**
 * Donut of the four allocation shares.
 * Geometry only: the numbers come from the plugin and are passed through.
 */
export function donut(percentages) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;

  const segments = [
    ["spending", "spending"],
    ["savings", "savings"],
    ["reserve", "emergencyReserve"],
    ["unallocated", "unallocated"],
  ];

  let consumed = 0;
  const circles = segments
    .map(([category, key]) => {
      const value = Math.max(0, Math.min(100, Number(percentages?.[key] ?? 0)));
      if (!Number.isFinite(value) || value <= 0) return "";
      const length = (value / 100) * circumference;
      const markup = `<circle class="donut-seg" data-cat="${category}" cx="50" cy="50" r="${radius}"
        stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}"
        stroke-dashoffset="${(-consumed).toFixed(2)}" />`;
      consumed += length;
      return markup;
    })
    .join("");

  const allocated = 100 - Math.max(0, Math.min(100, Number(percentages?.unallocated ?? 0)));

  return `
    <div class="donut-wrap">
      <svg class="donut" viewBox="0 0 100 100" role="img" aria-label="Allocation share as a donut chart">
        <circle class="donut-track" cx="50" cy="50" r="${radius}" />
        ${circles}
      </svg>
      <div class="donut-center">
        <div class="donut-center-value">${allocated.toFixed(0)}%</div>
        <div class="donut-center-label">Allocated</div>
      </div>
    </div>`;
}

/** One 100% wide bar showing the same four shares. */
export function stackBar(percentages) {
  const parts = [
    ["spending", "spending"],
    ["savings", "savings"],
    ["reserve", "emergencyReserve"],
    ["unallocated", "unallocated"],
  ];
  const segments = parts
    .map(([category, key]) => {
      const value = Math.max(0, Math.min(100, Number(percentages?.[key] ?? 0)));
      if (!Number.isFinite(value) || value <= 0) return "";
      return `<span class="stack-seg" data-cat="${category}" style="width:${value}%" title="${esc(category)}: ${esc(pct(percentages[key]))}"></span>`;
    })
    .join("");
  return `<div class="stack-bar" role="img" aria-label="Allocation split across spending, savings, emergency reserve and unallocated">${segments}</div>`;
}

export function legend(percentages, amounts) {
  const rows = [
    ["spending", "Spending", amounts.spendingUsdc, percentages.spending],
    ["savings", "Savings", amounts.savingsUsdc, percentages.savings],
    ["reserve", "Emergency reserve", amounts.emergencyReserveUsdc, percentages.emergencyReserve],
    ["unallocated", "Unallocated", amounts.unallocatedUsdc, percentages.unallocated],
  ];

  return `
    <div class="legend">
      ${rows
        .map(
          ([category, name, amountValue, percentage]) => `
        <div class="legend-item">
          <span class="legend-swatch" data-cat="${category}" aria-hidden="true"></span>
          <span class="legend-name">${esc(name)}</span>
          <span class="legend-amount">${esc(money(amountValue))}</span>
          <span class="legend-pct">${esc(pct(percentage))}</span>
        </div>`,
        )
        .join("")}
    </div>`;
}

/** Small status label used in the activity table. */
export function outcomeBadge(outcome) {
  const map = {
    planned: ["teal", "Planned"],
    checked: ["neutral", "Checked"],
    allowed: ["allow", "Allowed"],
    blocked: ["block", "Blocked"],
    review_required: ["review", "Review"],
    proposal: ["teal", "Proposal"],
    refused: ["neutral", "No proposal"],
    error: ["block", "Error"],
  };
  const [tone, label] = map[outcome] ?? ["neutral", outcome ?? "—"];
  return `<span class="badge" data-tone="${tone}">${esc(label)}</span>`;
}

/** Labelled value with a copy button. `truncate` keeps long hashes on one line. */
export function copyField(label, value, { truncate = true } = {}) {
  return `
    <div class="copy-field">
      <span class="copy-label">${esc(label)}</span>
      <code class="copy-value${truncate ? " is-truncated" : ""}" title="${esc(value)}">${esc(value)}</code>
      <button class="copy-button" type="button" data-copy="${esc(value)}"
        data-copy-label="${esc(label)} copied" aria-label="Copy ${esc(label).toLowerCase()}">
        ${icons.copy}
      </button>
    </div>`;
}

/** Human names for the four plugin tools, used wherever a call is described. */
export const TOOL_LABELS = {
  plan_stablecoin_allocation: "Allocation plan",
  check_payment_policy: "Payment check",
  propose_usdc_payment: "Payment proposal",
  get_allocation_report: "Allocation report",
};

/**
 * Brings a result panel into view after it fills with something the person
 * asked for. Does nothing when the panel is already comfortably visible.
 */
export function reveal(node) {
  if (!node) return;
  const rect = node.getBoundingClientRect();
  if (rect.top >= 0 && rect.top < window.innerHeight * 0.6) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  node.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
}

export function kv(rows) {
  return `
    <div class="kv">
      ${rows
        .map(
          ([key, value, extra = ""]) => `
        <div class="kv-row">
          <div class="kv-key">${esc(key)}</div>
          <div class="kv-value">${value}${extra}</div>
        </div>`,
        )
        .join("")}
    </div>`;
}

export function skeletonLines(count = 3) {
  return `<div class="stack" aria-hidden="true">${Array.from({ length: count })
    .map(() => `<div class="skeleton" style="height:14px;width:${60 + Math.round(Math.random() * 35)}%"></div>`)
    .join("")}</div>`;
}
