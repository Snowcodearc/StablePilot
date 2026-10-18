// Settings.
//
// Policy defaults, the data this browser keeps, and the identity of the plugin
// build being driven. No account, no wallet, no server-side profile.

import { field, readFields, selectField, setErrors, switchField } from "../components/fields.js";
import { alertBox, pageHead } from "../components/ui.js";
import { esc } from "../lib/dom.js";
import { addressError, amountError } from "../lib/format.js";
import { health } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { clearAll, getActivity, getSettings, updateSettings } from "../lib/store.js";

export async function render(root) {
  const settings = getSettings();
  const entries = getActivity().length;

  root.innerHTML = `
    ${pageHead(
      "Settings",
      "Defaults used to prefill the other screens, plus a clear view of what this browser stores.",
    )}
    <div class="split">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Policy defaults</h2>
            <p class="panel-sub">Prefilled into the checker and the proposal form</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form" id="settings-form" novalidate>
            <div class="form-grid">
              ${field({
                id: "maxPaymentUsdc",
                label: "Maximum per payment",
                hint: "A hard ceiling. Without it every payment needs review.",
                value: settings.maxPaymentUsdc,
                placeholder: "100",
                optional: true,
                span: true,
              })}
              ${field({
                id: "minEmergencyReserveUsdc",
                label: "Reserve floor",
                hint: "The reserve that must remain after any payment.",
                value: settings.minEmergencyReserveUsdc,
                optional: true,
              })}
              ${field({
                id: "savingsGoalUsdc",
                label: "Savings goal",
                hint: "Measured against the savings allocation on the planner.",
                value: settings.savingsGoalUsdc,
                optional: true,
              })}
              ${field({
                id: "recipient",
                label: "Default recipient",
                hint: "Used to prefill the checker and proposals.",
                value: settings.recipient,
                suffix: "",
                placeholder: "0x…",
                inputmode: "text",
                span: true,
              })}
              ${selectField({
                id: "chain",
                label: "Network",
                hint: "Base mainnet, as a name or a CAIP-2 id.",
                value: settings.chain ?? "base",
                options: [
                  { value: "base", label: "Base" },
                  { value: "eip155:8453", label: "Base · eip155:8453" },
                ],
              })}
              ${switchField({
                id: "explain",
                label: "Ask the plugin for explanations",
                hint: "Adds a written summary to allocation plans.",
                checked: settings.explain !== false,
              })}
            </div>
            <div class="button-row">
              <button class="button button-primary" type="submit" id="save-settings">Save preferences</button>
            </div>
          </form>
        </div>
      </section>

      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Saved data</h2>
              <p class="panel-sub">Stored in this browser only</p>
            </div>
          </div>
          <div class="panel-body">
            <div class="kv">
              <div class="kv-row">
                <div class="kv-key">Plan figures</div>
                <div class="kv-value">${settings.totalUsdc ? `${esc(settings.totalUsdc)} USDC total` : "none yet"}</div>
              </div>
              <div class="kv-row">
                <div class="kv-key">Activity entries</div>
                <div class="kv-value">${entries}</div>
              </div>
              <div class="kv-row">
                <div class="kv-key">Where</div>
                <div class="kv-value">This browser's localStorage</div>
              </div>
              <div class="kv-row">
                <div class="kv-key">Storage key</div>
                <div class="kv-value mono">stablepilot.web.v1</div>
              </div>
            </div>
            <p class="small faint" style="margin-top:12px">
              Nothing is sent to a server. Clearing this data removes the saved figures and the local activity log.
            </p>
            <div class="button-row" style="margin-top:14px">
              <button class="button button-quiet" type="button" id="reset-all" data-tone="danger">
                Clear saved data
              </button>
            </div>
          </div>
        </section>

        <section class="panel" id="about">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Plugin</h2>
              <p class="panel-sub">The build this interface is driving</p>
            </div>
          </div>
          <div class="panel-body" id="about-body">
            <div class="inline small muted"><span class="spinner" aria-hidden="true"></span>Reading plugin info…</div>
          </div>
        </section>
      </div>
    </div>`;

  const form = root.querySelector("#settings-form");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = readFields(form);

    const errors = {
      maxPaymentUsdc: amountError(values.maxPaymentUsdc, { label: "Maximum per payment", required: false }),
      minEmergencyReserveUsdc: amountError(values.minEmergencyReserveUsdc, {
        label: "Reserve floor",
        required: false,
      }),
      savingsGoalUsdc: amountError(values.savingsGoalUsdc, { label: "Savings goal", required: false }),
      recipient: addressError(values.recipient),
    };

    if (setErrors(form, errors)) return;

    updateSettings({
      maxPaymentUsdc: values.maxPaymentUsdc,
      minEmergencyReserveUsdc: values.minEmergencyReserveUsdc,
      savingsGoalUsdc: values.savingsGoalUsdc,
      recipient: values.recipient,
      chain: values.chain,
      explain: values.explain,
    });
    toast("Preferences saved");
  });

  const reset = root.querySelector("#reset-all");
  reset.addEventListener("click", () => {
    if (reset.dataset.armed !== "true") {
      reset.dataset.armed = "true";
      reset.textContent = "Tap again to confirm";
      setTimeout(() => {
        if (!reset.isConnected) return;
        reset.dataset.armed = "false";
        reset.textContent = "Clear saved data";
      }, 4000);
      return;
    }
    clearAll();
    toast("Saved data cleared");
    render(root);
  });

  await fillAbout(root.querySelector("#about-body"));
}

async function fillAbout(body) {
  try {
    const info = await health();
    body.innerHTML = `
      <div class="kv">
        <div class="kv-row">
          <div class="kv-key">Artifact</div>
          <div class="kv-value mono" title="${esc(info.artifact.path)}">${esc(shortPath(info.artifact.path))}</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Size</div>
          <div class="kv-value">${esc(info.artifact.bytes.toLocaleString())} bytes</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">sha256</div>
          <div class="kv-value mono" style="word-break:break-all;font-size:0.75rem">${esc(info.artifact.sha256)}</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Protocol</div>
          <div class="kv-value mono">${esc(info.protocolVersion)} · stdio</div>
        </div>
        <div class="kv-row">
          <div class="kv-key">Tools</div>
          <div class="kv-value">${info.tools.map((tool) => `<code>${esc(tool.name)}</code>`).join(" ")}</div>
        </div>
      </div>
      <p class="small faint" style="margin-top:12px">
        The same <code>dist/plugin.mjs</code> is what gets uploaded to PayBox. This interface spawns it per call over
        stdio; it does not modify or replace it.
      </p>`;
  } catch (error) {
    body.innerHTML = alertBox(
      "error",
      "Plugin info unavailable",
      `${esc(error?.message ?? String(error))}. Check that the backend and the plugin artifact are present.`,
    );
  }
}

/** "C:\Users\…\StablePilot\dist\plugin.mjs" -> "dist/plugin.mjs" */
function shortPath(value) {
  return String(value).split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}
