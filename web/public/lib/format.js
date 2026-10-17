// Formatting and the one piece of arithmetic the browser is allowed to do.
//
// The plugin is the only source of truth for allocations, percentages and
// decisions. This module formats what it returns, and mirrors the plugin's
// decimal grammar for inline form feedback so a typo is caught before a request
// is made. Nothing here decides an outcome.

/** The exact decimal grammar the plugin accepts: no sign, no commas, max 6dp. */
export const USDC_AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const ATOMS = 6;
const SCALE = 10n ** BigInt(ATOMS);

const amountFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 6,
});

const compactFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** "1000" -> "1,000", "0.00" -> "0", "12.3456" -> "12.3456". */
export function money(value) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return amountFormat.format(parsed);
}

/** A USDC figure with its unit, for prose. */
export function amount(value) {
  return `${money(value)} USDC`;
}

/** The plugin returns two-decimal strings such as "30.00"; show them verbatim. */
export function pct(value) {
  if (value === null || value === undefined || value === "") return "—";
  return `${value}%`;
}

export function shortAddress(address) {
  if (typeof address !== "string" || address.length < 12) return address ?? "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Parses a decimal string into integer atoms of 10^-6, or null if malformed. */
export function toAtoms(value) {
  const text = String(value ?? "").trim();
  if (!USDC_AMOUNT.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(ATOMS, "0"));
}

/** Formats integer atoms back into the plugin's decimal string form. */
export function fromAtoms(atoms) {
  const whole = atoms / SCALE;
  const fraction = (atoms % SCALE).toString().padStart(ATOMS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Sums decimal strings without floating point, for the "these add up to"
 * hint under the planner form. Returns null if any input is not a valid amount.
 */
export function sumAmounts(values) {
  let total = 0n;
  for (const value of values) {
    if (value === "" || value === undefined || value === null) continue;
    const atoms = toAtoms(value);
    if (atoms === null) return null;
    total += atoms;
  }
  return fromAtoms(total);
}

/**
 * Inline validation for a USDC field.
 * Returns a message for the field, or null when the value is acceptable.
 */
export function amountError(value, { label = "This amount", required = true } = {}) {
  const text = String(value ?? "").trim();
  if (text === "") return required ? `${label} is required.` : null;
  if (!USDC_AMOUNT.test(text)) {
    if (/^-/.test(text)) return `${label} cannot be negative.`;
    if (/,/.test(text)) return `Use a plain decimal such as 1200.50, without commas.`;
    if (/^0[0-9]/.test(text)) return `Remove the leading zero, or use 0 on its own.`;
    if (!Number.isFinite(Number(text))) return `Enter a plain number, for example 250 or 250.75.`;
    if (Number(text) < 0) return `${label} cannot be negative.`;
    return `Use at most six decimal places, for example 12.345678.`;
  }
  return null;
}

export function addressError(value, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (text === "") return required ? "A recipient address is required." : null;
  if (!EVM_ADDRESS.test(text)) return "Enter a 40-character hex address starting with 0x.";
  return null;
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function clockTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : timeFormat.format(date);
}

export function dateTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFormat.format(date);
}

/** "just now", "4 min ago", "2 h ago", else a short date. */
export function relative(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return dateTimeFormat.format(date);
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function compact(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? compactFormat.format(parsed) : String(value);
}
