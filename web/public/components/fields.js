// Form primitives. Every control has a label, a hint and a place for an inline
// error, so views only describe their fields.

import { esc } from "../lib/dom.js";

export function field({
  id,
  label,
  hint = "",
  value = "",
  suffix = "USDC",
  optional = false,
  placeholder = "",
  inputmode = "decimal",
  autocomplete = "off",
  span = false,
  type = "text",
}) {
  return `
    <div class="field${span ? " span-2" : ""}">
      <label class="field-label" for="${esc(id)}">
        ${esc(label)}
        ${optional ? `<span class="field-optional">optional</span>` : ""}
      </label>
      <div class="input-wrap">
        <input
          class="input${suffix ? " has-suffix" : ""} amount"
          id="${esc(id)}"
          name="${esc(id)}"
          type="${esc(type)}"
          inputmode="${esc(inputmode)}"
          autocomplete="${esc(autocomplete)}"
          spellcheck="false"
          placeholder="${esc(placeholder)}"
          value="${esc(value)}"
          aria-describedby="${esc(id)}-hint ${esc(id)}-error"
        />
        ${suffix ? `<span class="input-suffix">${esc(suffix)}</span>` : ""}
      </div>
      <p class="field-hint" id="${esc(id)}-hint">${esc(hint)}</p>
      <p class="field-error" id="${esc(id)}-error" hidden></p>
    </div>`;
}

export function selectField({ id, label, hint = "", value, options, span = false }) {
  return `
    <div class="field${span ? " span-2" : ""}">
      <label class="field-label" for="${esc(id)}">${esc(label)}</label>
      <div class="input-wrap">
        <select class="input" id="${esc(id)}" name="${esc(id)}" aria-describedby="${esc(id)}-hint ${esc(id)}-error">
          ${options
            .map(
              (option) =>
                `<option value="${esc(option.value)}"${option.value === value ? " selected" : ""}>${esc(option.label)}</option>`,
            )
            .join("")}
        </select>
      </div>
      <p class="field-hint" id="${esc(id)}-hint">${esc(hint)}</p>
      <p class="field-error" id="${esc(id)}-error" hidden></p>
    </div>`;
}

export function switchField({ id, label, hint = "", checked = false }) {
  return `
    <div class="field span-2">
      <label class="switch" for="${esc(id)}">
        <input type="checkbox" id="${esc(id)}" name="${esc(id)}" ${checked ? "checked" : ""} />
        <span class="switch-text">
          <span class="switch-title">${esc(label)}</span>
          <span class="field-hint">${esc(hint)}</span>
        </span>
      </label>
    </div>`;
}

/** Reads every named input inside a container. */
export function readFields(root) {
  const values = {};
  for (const input of root.querySelectorAll("input[name], select[name]")) {
    values[input.name] = input.type === "checkbox" ? input.checked : input.value.trim();
  }
  return values;
}

/** Applies `{ id: message }` to the matching fields and clears the rest. */
export function setErrors(root, errors) {
  for (const node of root.querySelectorAll(".field-error")) {
    node.hidden = true;
    node.textContent = "";
  }
  for (const input of root.querySelectorAll("[aria-invalid]")) {
    input.removeAttribute("aria-invalid");
  }

  let firstInvalid = null;
  for (const [id, message] of Object.entries(errors)) {
    if (!message) continue;
    const input = root.querySelector(`#${CSS.escape(id)}`);
    const slot = root.querySelector(`#${CSS.escape(id)}-error`);
    if (input) {
      input.setAttribute("aria-invalid", "true");
      firstInvalid ??= input;
    }
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
  }

  firstInvalid?.focus();
  return Object.keys(errors).some((key) => errors[key]);
}

export function clearErrors(root) {
  setErrors(root, {});
}

/** Puts a submit button into a loading state without changing its width twice. */
export function setBusy(button, busy, busyLabel = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(busyLabel)}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.textContent = button.dataset.label;
  }
}
