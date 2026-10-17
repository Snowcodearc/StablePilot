// Transient confirmations. Toasts are for "the thing you did happened"; errors
// that matter stay on the page next to the control that produced them.

import { esc, icons } from "./dom.js";

const stack = () => document.getElementById("toasts");

export function toast(message, { tone = "default", timeout = 4200 } = {}) {
  const host = stack();
  if (!host) return;

  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;
  node.innerHTML = `<span class="toast-icon">${tone === "error" ? icons.bang : icons.check}</span><span class="toast-text">${esc(message)}</span>`;
  host.append(node);

  const remove = () => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    setTimeout(() => node.remove(), 160);
  };

  setTimeout(remove, timeout);
}

/** Copies text, with a sensible fallback for a non-secure context. */
export async function copyText(text, label = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.("copy");
    area.remove();
    if (ok) toast(label);
    else toast("Could not copy automatically. Select the value and copy it manually.", { tone: "error" });
    return Boolean(ok);
  }
}
