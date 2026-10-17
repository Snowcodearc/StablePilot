// Small DOM helpers. No framework, no virtual DOM: the app is six screens of
// forms and tables, so plain elements with explicit escaping stay readable.

/** Escapes text for safe interpolation into an HTML template string. */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Turns an HTML string into a single element. */
export function el(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

/** Replaces the contents of a container. */
export function mount(container, html) {
  container.innerHTML = html;
  return container;
}

/** Delegated click handling, so re-rendered markup needs no re-binding. */
export function onClick(root, selector, handler) {
  root.addEventListener("click", (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  });
}

/** Inline SVG icons, sized by the font, never emoji. */
export const icons = {
  check: `<svg class="badge-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.2 11.7 13 4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cross: `<svg class="badge-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  bang: `<svg class="badge-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1" fill="currentColor"/></svg>`,
  dot: `<svg class="badge-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>`,
  info: `<svg class="alert-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.8" fill="currentColor"/></svg>`,
  lock: `<svg class="balance-note-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`,
  arrow: `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h8M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plan: `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 11.6 6 8.2l2.6 2.6L13.4 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  shield: `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 13 4v3.9c0 2.6-1.9 4.9-5 5.9-3.1-1-5-3.3-5-5.9V4l5-1.8Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.9 8 7.4 9.5 10.3 6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  send: `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8 13 3 10.6 13 8 9.4 2.5 8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.4" y="5.4" width="7.4" height="7.4" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.4 5.4V4.3a1.5 1.5 0 0 0-1.5-1.5H4.3a1.5 1.5 0 0 0-1.5 1.5v4.6a1.5 1.5 0 0 0 1.5 1.5h1.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};
