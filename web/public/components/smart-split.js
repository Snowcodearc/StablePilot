// Wires the Smart Split panel to the real `plan_stablecoin_allocation` tool.
//
// The preview under the input is local arithmetic (see lib/split.js) and is
// labelled as such. The confirmed plan underneath comes only from the plugin's
// response; if the call fails, the preview is relabelled and nothing is saved.

import {
  failureHtml,
  loadingHtml,
  previewHtml,
  smartSplitShell,
  successHtml,
} from "./smart-split-view.js";
import { setBusy } from "./fields.js";
import { callTool } from "../lib/api.js";
import { addActivity, getSettings, setLastPlan, updateSettings } from "../lib/store.js";
import { TOOL, activitySummary, planPayload, splitAmount } from "../lib/split.js";
import { money } from "../lib/format.js";
import { toast } from "../lib/toast.js";

/** The amount to prefill: the last plan this browser generated, if any. */
function prefill() {
  const stored = String(getSettings().smartSplitAmount ?? "").trim();
  return splitAmount(stored).ok ? stored : "";
}

export function mountSmartSplit(container, { onPlan } = {}) {
  container.innerHTML = smartSplitShell({ value: prefill() });

  const form = container.querySelector("#smart-split-form");
  const input = container.querySelector("#smart-split-amount");
  const errorSlot = container.querySelector("#smart-split-error");
  const preview = container.querySelector("#smart-split-preview");
  const result = container.querySelector("#smart-split-result");
  const submit = container.querySelector("#smart-split-submit");

  let attempted = false;
  let busy = false;

  function showError(message) {
    const hasError = Boolean(message);
    errorSlot.textContent = message ?? "";
    errorSlot.hidden = !hasError;
    if (hasError) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function renderPreview(state) {
    preview.innerHTML = previewHtml(splitAmount(input.value), { state });
  }

  function clearResult() {
    result.innerHTML = "";
  }

  input.addEventListener("input", () => {
    const current = splitAmount(input.value);
    preview.innerHTML = previewHtml(current, { state: current.ok ? "ready" : "empty" });
    if (attempted || current.ok) showError(current.ok ? "" : current.error);
    if (result.childElementCount > 0) clearResult();
  });

  input.addEventListener("blur", () => {
    const current = splitAmount(input.value);
    if (input.value.trim() !== "" && !current.ok) showError(current.error);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;

    attempted = true;
    const current = splitAmount(input.value);

    if (!current.ok) {
      showError(current.error);
      renderPreview("empty");
      clearResult();
      input.focus();
      return;
    }

    showError("");
    busy = true;
    setBusy(submit, true, "Generating plan…");
    preview.innerHTML = previewHtml(current, { state: "ready" });
    result.innerHTML = loadingHtml();

    try {
      const response = await callTool(TOOL, planPayload(current));
      const { result: toolResult, durationMs } = response;

      if (toolResult?.isError === true) {
        const message = toolResult.content?.[0]?.text ?? "The plugin refused this allocation.";
        result.innerHTML = failureHtml(message);
        preview.innerHTML = previewHtml(current, { state: "unvalidated" });
        addActivity({
          tool: TOOL,
          outcome: "error",
          summary: message.split("\n")[0],
          durationMs,
        });
        toast("The plugin refused that allocation", { tone: "error" });
        wireRetry();
        return;
      }

      const plan = toolResult?.structuredContent?.plan;
      if (!plan) {
        result.innerHTML = failureHtml("The plugin returned no plan.");
        preview.innerHTML = previewHtml(current, { state: "unvalidated" });
        wireRetry();
        return;
      }

      const at = new Date().toISOString();
      setLastPlan({ at, plan });
      // The confirmed plan becomes the figures the rest of the app reads.
      updateSettings({
        smartSplitAmount: current.input,
        totalUsdc: plan.totalUsdc,
        spendingUsdc: plan.spendingUsdc,
        savingsUsdc: plan.savingsUsdc,
        emergencyReserveUsdc: plan.emergencyReserveUsdc,
      });

      result.innerHTML = successHtml(plan, { durationMs });
      preview.innerHTML = previewHtml(current, { state: "validated" });
      addActivity({
        tool: TOOL,
        outcome: "planned",
        summary: `Smart Split · ${activitySummary(current)} · ${money(plan.totalAllocatedUsdc)} USDC allocated`,
        durationMs,
      });
      toast("Plan generated. No funds moved.", { tone: "default" });

      result.querySelector("[data-use-plan]")?.addEventListener("click", () => {
        location.assign("/planner");
      });
      wireRetry();

      Promise.resolve(onPlan?.()).catch(() => {
        // The confirmed plan is already on screen; a failed refresh of the
        // panels below must not replace it with an error.
      });
    } catch (error) {
      const offline = error?.code === "offline";
      result.innerHTML = failureHtml(error?.message ?? "The request failed.", { network: offline });
      preview.innerHTML = previewHtml(current, { state: "unvalidated" });
      wireRetry();
    } finally {
      busy = false;
      setBusy(submit, false);
    }
  });

  function wireRetry() {
    result.querySelector("[data-retry]")?.addEventListener("click", () => {
      form.requestSubmit();
    });
  }

  renderPreview(prefill() ? "ready" : "empty");
}
