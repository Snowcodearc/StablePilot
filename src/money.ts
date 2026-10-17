// Decimal-safe USDC arithmetic.
//
// Every monetary value in StablePilot is parsed into an integer number of
// atomic units (bigint) before any arithmetic happens. No JavaScript `number`
// ever touches a token amount, so there is no binary floating-point drift and
// no rounding surprise at transfer time.

export const USDC_DECIMALS = 6;
export const USDC_ATOMIC_FACTOR = 1_000_000n;

export type AmountParse =
  | { ok: true; atoms: bigint; canonical: string }
  | { ok: false; error: string };

/**
 * Parse a decimal amount string into atomic units.
 *
 * Accepted: "0", "10", "10.5", "0.000001", "100.000000".
 * Rejected: negatives, "+1", "1e6", ".5", "1.", " 10", "007", "" and anything
 * with more precision than USDC supports. Rejections carry a user-facing reason.
 */
export function parseAmount(input: unknown): AmountParse {
  if (input === undefined || input === null) {
    return { ok: false, error: "An amount is required." };
  }
  if (typeof input !== "string") {
    return {
      ok: false,
      error: `Amounts must be decimal strings (for example "10.50"), got ${typeof input}.`,
    };
  }
  const value = input;
  if (value.length === 0) {
    return { ok: false, error: "An amount is required." };
  }
  if (/\s/.test(value)) {
    return { ok: false, error: `"${value}" contains whitespace. Provide a plain decimal amount.` };
  }
  if (value.startsWith("-")) {
    return { ok: false, error: `"${value}" is negative. Amounts must be zero or greater.` };
  }
  if (/^[+]/.test(value)) {
    return { ok: false, error: `"${value}" has a leading sign. Provide a plain decimal amount.` };
  }
  if (/[eE]/.test(value)) {
    return {
      ok: false,
      error: `"${value}" uses scientific notation. Provide a plain decimal amount such as "1000.25".`,
    };
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    return {
      ok: false,
      error: `"${value}" is not a valid decimal amount. Use digits with an optional single decimal point.`,
    };
  }

  const [, wholePart = "", fractionPart = ""] = match;

  if (fractionPart.length > USDC_DECIMALS) {
    return {
      ok: false,
      error: `"${value}" has ${fractionPart.length} decimal places. USDC supports at most ${USDC_DECIMALS}.`,
    };
  }
  if (wholePart.length > 1 && wholePart.startsWith("0")) {
    return { ok: false, error: `"${value}" has a leading zero. Write it as "${String(BigInt(wholePart))}".` };
  }

  const paddedFraction = fractionPart.padEnd(USDC_DECIMALS, "0");
  const atoms = BigInt(wholePart) * USDC_ATOMIC_FACTOR + BigInt(paddedFraction);
  return { ok: true, atoms, canonical: formatAtoms(atoms) };
}

/** Render atomic units as a canonical decimal string, trimming trailing zeros. */
export function formatAtoms(atoms: bigint): string {
  const negative = atoms < 0n;
  const magnitude = negative ? -atoms : atoms;
  const whole = magnitude / USDC_ATOMIC_FACTOR;
  const fraction = magnitude % USDC_ATOMIC_FACTOR;
  const sign = negative ? "-" : "";
  if (fraction === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${fraction.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "")}`;
}

/** Percentage of `total` represented by `part`, as a 2-decimal string. */
export function formatPercent(part: bigint, total: bigint): string {
  if (total === 0n) return "0.00";
  const basisPoints = (part * 10_000n + total / 2n) / total;
  return basisPointsToPercent(basisPoints);
}

function basisPointsToPercent(basisPoints: bigint): string {
  const whole = basisPoints / 100n;
  const fraction = (basisPoints % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

/** Compare two decimal amount strings without going through floating point. */
export function compareAmounts(a: string, b: string): number {
  const left = parseAmount(a);
  const right = parseAmount(b);
  if (!left.ok || !right.ok) {
    throw new Error("compareAmounts requires two valid decimal amount strings.");
  }
  if (left.atoms === right.atoms) return 0;
  return left.atoms > right.atoms ? 1 : -1;
}
