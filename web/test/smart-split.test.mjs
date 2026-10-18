// Smart Split tests.
//
// The arithmetic, the tool mapping and the wording of every UI state, all
// without a browser. The end-to-end proof that the panel reaches the real
// plugin lives in adapter.test.mjs.
//
//   node --test web/test/

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  MIN_USDC,
  SPLIT_PERCENT,
  TOOL,
  activitySummary,
  planPayload,
  splitAmount,
} from "../public/lib/split.js";
import {
  failureHtml,
  loadingHtml,
  previewHtml,
  smartSplitShell,
  successHtml,
} from "../public/components/smart-split-view.js";
import { toAtoms } from "../public/lib/format.js";

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("split arithmetic", () => {
  it("publishes percentages that total exactly 100", () => {
    const total = SPLIT_PERCENT.spending + SPLIT_PERCENT.savings + SPLIT_PERCENT.reserve;
    assert.equal(total, 100);
    assert.deepEqual({ ...SPLIT_PERCENT }, { spending: 30, savings: 50, reserve: 20 });
  });

  for (const [input, expected] of [
    ["100", { spending: "30", savings: "50", reserve: "20" }],
    ["250", { spending: "75", savings: "125", reserve: "50" }],
    ["1000", { spending: "300", savings: "500", reserve: "200" }],
    ["1000.5", { spending: "300.15", savings: "500.25", reserve: "200.1" }],
    ["123.45", { spending: "37.035", savings: "61.725", reserve: "24.69" }],
  ]) {
    it(`splits ${input} into 30/50/20 exactly`, () => {
      const split = splitAmount(input);
      assert.equal(split.ok, true, split.error);
      assert.deepEqual(split.amounts, expected);
      assert.equal(split.unallocated, "0");
    });
  }

  it("reconciles to six decimals on amounts that do not divide evenly", () => {
    for (const input of ["100.000001", "100.000003", "999.999999", "123456.789012", "1110.5"]) {
      const split = splitAmount(input);
      assert.equal(split.ok, true, `${input}: ${split.error}`);
      const sum =
        Number(split.amounts.spending) + Number(split.amounts.savings) + Number(split.amounts.reserve);
      assert.ok(Math.abs(sum - Number(input)) < 1e-9, `${input} summed to ${sum}`);
    }
  });

  it("puts the rounding remainder in the reserve instead of losing it", () => {
    // 100.000001 * 30% = 30.0000003, floored to 30.000000; the 0.000001 lands
    // in the reserve so the three parts still add up to the entered amount.
    const split = splitAmount("100.000001");
    assert.deepEqual(split.amounts, { spending: "30", savings: "50", reserve: "20.000001" });
    assert.equal(split.remainderAtoms, 1n);
  });

  it("keeps integer atoms, not floats", () => {
    const split = splitAmount("1000.000001");
    assert.equal(typeof split.atoms, "bigint");
    assert.equal(split.atoms, toAtoms("1000.000001"));
    assert.equal(
      toAtoms(split.amounts.spending) + toAtoms(split.amounts.savings) + toAtoms(split.amounts.reserve),
      split.atoms,
    );
  });
});

describe("validation", () => {
  it("accepts the 100 USDC minimum and rejects just below it", () => {
    assert.equal(splitAmount("100").ok, true);
    assert.equal(MIN_USDC, "100");

    const under = splitAmount("99.999999");
    assert.equal(under.ok, false);
    assert.match(under.error, /minimum is 100 USDC/i);
    assert.match(under.error, /99\.999999/);
  });

  it("rejects empty, blank and missing values", () => {
    for (const value of ["", "   ", null, undefined]) {
      const split = splitAmount(value);
      assert.equal(split.ok, false);
      assert.match(split.error, /enter the amount/i);
    }
  });

  it("rejects zero", () => {
    const split = splitAmount("0");
    assert.equal(split.ok, false);
    assert.match(split.error, /at least 100 USDC/i);
  });

  it("rejects negative amounts", () => {
    for (const value of ["-1", "-100", "−250"]) {
      const split = splitAmount(value);
      assert.equal(split.ok, false);
      assert.match(split.error, /negative/i);
    }
  });

  it("rejects non-numeric and malformed input", () => {
    for (const value of ["abc", "1,000", "1.2.3", "12abc", "$500", "1e3", "0x10"]) {
      const split = splitAmount(value);
      assert.equal(split.ok, false, `${value} should be rejected`);
      assert.ok(split.error.length > 0);
    }
  });

  it("rejects more than six decimal places", () => {
    const split = splitAmount("100.1234567");
    assert.equal(split.ok, false);
    assert.match(split.error, /six decimal/i);
    assert.equal(splitAmount("100.123456").ok, true);
  });

  it("never rewrites the amount the user typed", () => {
    const split = splitAmount("100.50");
    assert.equal(split.input, "100.50");
    assert.equal(planPayload(split).totalUsdc, "100.50");
  });
});

describe("tool mapping", () => {
  it("names the existing tool and nothing else", () => {
    assert.equal(TOOL, "plan_stablecoin_allocation");
  });

  it("maps 1,000 USDC to the documented payload", () => {
    const payload = planPayload(splitAmount("1000"));
    assert.deepEqual(payload, {
      totalUsdc: "1000",
      spendingUsdc: "300",
      savingsUsdc: "500",
      emergencyReserveUsdc: "200",
      explain: true,
    });
  });

  it("sends decimal strings only", () => {
    const payload = planPayload(splitAmount("250.5"));
    for (const [key, value] of Object.entries(payload)) {
      if (key === "explain") assert.equal(value, true);
      else assert.equal(typeof value, "string");
    }
  });

  it("summarises the split for the activity log", () => {
    assert.match(activitySummary(splitAmount("1000")), /1,000 USDC split 30\/50\/20/);
  });
});

describe("interface states", () => {
  const plan = {
    totalUsdc: "1000",
    spendingUsdc: "300",
    savingsUsdc: "500",
    emergencyReserveUsdc: "200",
    unallocatedUsdc: "0",
    totalAllocatedUsdc: "1000",
    percentages: { spending: "30.00", savings: "50.00", emergencyReserve: "20.00", unallocated: "0.00" },
    explanation: "Decision: planned.",
  };

  it("renders the required copy, input and primary button", () => {
    const html = smartSplitShell({ value: "" });
    assert.match(html, /Give every dollar a purpose\./);
    assert.match(html, /Minimum 100 USDC\./);
    assert.match(html, /Amount to allocate/);
    assert.match(html, /USDC/);
    assert.match(html, /Generate allocation plan/);
    assert.match(html, /id="smart-split-amount"/);
    assert.match(html, /aria-describedby="smart-split-hint smart-split-error"/);
    assert.equal(html.includes("no wallet is connected"), true);
  });

  it("prefills without altering a stored amount", () => {
    const html = smartSplitShell({ value: "250.75" });
    assert.match(html, /value="250\.75"/);
  });

  it("shows an empty preview until an amount is entered", () => {
    const html = previewHtml(null, { state: "empty" });
    assert.match(html, /Live preview/);
    assert.match(html, /Enter at least 100 USDC/);
    assert.equal(html.includes("&mdash;"), true);
    assert.equal(html.includes("30%"), true);
    assert.equal(html.includes("50%"), true);
    assert.equal(html.includes("20%"), true);
  });

  it("shows live amounts and a total for a valid preview", () => {
    const html = previewHtml(splitAmount("1000"), { state: "ready" });
    assert.match(html, /300/);
    assert.match(html, /500/);
    assert.match(html, /200/);
    assert.match(html, /Total allocated/);
    assert.match(html, /1,000 USDC/);
  });

  it("labels an unvalidated preview as arithmetic only", () => {
    const html = previewHtml(splitAmount("1000"), { state: "unvalidated" });
    assert.match(html, /Not validated/);
    assert.match(html, /arithmetic only/);
  });

  it("shows a loading state that names the tool", () => {
    const html = loadingHtml();
    assert.match(html, /spinner/);
    assert.match(html, /plan_stablecoin_allocation/);
  });

  it("renders a success state from the plugin's figures only", () => {
    const html = successHtml(plan, { durationMs: 320 });
    assert.match(html, /Allocation plan generated\. No funds have been moved\./);
    assert.match(html, /30\.00%/);
    assert.match(html, /50\.00%/);
    assert.match(html, /20\.00%/);
    assert.match(html, /not a transaction/);
    assert.match(html, /320 ms/);
    assert.match(html, /Open in planner/);
  });

  it("shows a failure state that keeps the preview honest", () => {
    const html = failureHtml("totalUsdc: allocations exceed the balance");
    assert.match(html, /could not validate this plan/i);
    assert.match(html, /local arithmetic only/i);
    assert.match(html, /totalUsdc: allocations exceed the balance/);
    assert.equal(html.includes("No funds have been moved"), false);
    assert.equal(html.includes("Confirmed by plugin"), false);
  });

  it("treats a backend that is down as a network failure", () => {
    const html = failureHtml("Could not reach the StablePilot backend.", { network: true });
    assert.match(html, /did not answer/);
  });
});

describe("financial clarity", () => {
  const ALLOWED = "No funds have been moved.";

  const forbidden = [
    /funds?\s+(?:have|has|were)\s+(?:been\s+)?(?:moved|transferred|sent|deposited)/i,
    /transaction\s+(?:complete|completed|successful|confirmed)/i,
    /successfully\s+(?:sent|transferred|paid|deposited)/i,
    /deposited\s+into/i,
    /(?:your\s+)?(?:savings|reserve)\s+(?:account|vault)\s+(?:now\s+)?holds/i,
  ];

  const files = [
    "../public/components/smart-split-view.js",
    "../public/components/smart-split.js",
    "../public/views/overview.js",
    "../public/lib/split.js",
  ];

  for (const file of files) {
    it(`${file.split("/").pop()} never claims money moved`, async () => {
      const text = await source(file);
      // The one allowed sentence is the disclaimer itself; remove every
      // case variant of it before looking for claims that money moved.
      const stripped = text.replace(/no funds have been moved/gi, "");
      for (const pattern of forbidden) {
        assert.equal(pattern.test(stripped), false, `${file} matched ${pattern}`);
      }
    });
  }

  it("states the plan-only disclaimer in the view and the success state", async () => {
    const view = await source("../public/components/smart-split-view.js");
    assert.ok(view.includes(ALLOWED), "success state must say no funds have been moved");
    assert.match(view, /not a transaction/);
  });
});
