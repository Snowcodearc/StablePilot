// Router and shell behaviour. Six routes, no build step: the browser loads the
// modules directly, and the backend serves this directory.

import { health } from "./lib/api.js";
import { esc } from "./lib/dom.js";
import { copyText } from "./lib/toast.js";
import * as activity from "./views/activity.js";
import * as checker from "./views/checker.js";
import * as overview from "./views/overview.js";
import * as planner from "./views/planner.js";
import * as proposals from "./views/proposals.js";
import * as settings from "./views/settings.js";

const routes = {
  "/": { title: "Overview", view: overview },
  "/planner": { title: "Allocation Planner", view: planner },
  "/checker": { title: "Payment Checker", view: checker },
  "/proposals": { title: "Payment Proposals", view: proposals },
  "/activity": { title: "Activity History", view: activity },
  "/settings": { title: "Settings", view: settings },
};

const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("scrim");
const menuButton = document.getElementById("menu-button");
const routeLoading = document.getElementById("route-loading");
const viewRoot = document.getElementById("view");

let currentPath = "/";

function setActiveNav(path) {
  for (const link of document.querySelectorAll("[data-route]")) {
    const isActive = link.dataset.route === path;
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function closeDrawer() {
  sidebar.dataset.open = "false";
  scrim.hidden = true;
  menuButton?.setAttribute("aria-expanded", "false");
}

function openDrawer() {
  sidebar.dataset.open = "true";
  scrim.hidden = false;
  menuButton?.setAttribute("aria-expanded", "true");
}

export function navigate(path, { replace = false } = {}) {
  const target = routes[path] ? path : "/";
  if (target === currentPath && viewRoot.childElementCount > 0) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    closeDrawer();
    return;
  }

  currentPath = target;
  if (replace) history.replaceState({ path: target }, "", target);
  else history.pushState({ path: target }, "", target);

  renderRoute(target);
}

async function renderRoute(path) {
  const route = routes[path] ?? routes["/"];
  document.title = `${route.title} — StablePilot`;
  setActiveNav(path);
  closeDrawer();

  const slowTimer = setTimeout(() => {
    routeLoading.hidden = false;
  }, 160);

  try {
    viewRoot.innerHTML = "";
    await route.view.render(viewRoot);
  } catch (error) {
    viewRoot.innerHTML = `
      <div class="alert" data-tone="error" role="alert">
        <div class="alert-body">
          <div class="alert-title">This screen could not be loaded</div>
          <div>${esc(error?.message ?? String(error))}</div>
        </div>
      </div>`;
  } finally {
    clearTimeout(slowTimer);
    routeLoading.hidden = true;
  }

  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------
// Shell wiring
// ---------------------------------------------------------------------------

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route], a[href^='/']");
  if (link && !link.target && !link.hasAttribute("download")) {
    const path = link.dataset.route ?? new URL(link.href, location.origin).pathname;
    if (routes[path] || path.startsWith("/")) {
      event.preventDefault();
      navigate(path);
      return;
    }
  }

  const copy = event.target.closest("[data-copy]");
  if (copy) {
    event.preventDefault();
    copyText(copy.dataset.copy, copy.dataset.copyLabel ?? "Copied to clipboard");
  }
});

menuButton?.addEventListener("click", () => {
  if (sidebar.dataset.open === "true") closeDrawer();
  else openDrawer();
});

scrim?.addEventListener("click", closeDrawer);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sidebar.dataset.open === "true") closeDrawer();
});

window.addEventListener("popstate", () => {
  const path = location.pathname;
  currentPath = routes[path] ? path : "/";
  renderRoute(currentPath);
});

/** Shows which plugin build the backend is actually driving. */
async function checkPlugin() {
  const chip = document.getElementById("plugin-chip");
  const text = chip?.querySelector(".plugin-text");
  try {
    const info = await health();
    if (chip) chip.dataset.state = "live";
    if (text) text.textContent = `Plugin live · ${info.tools.length} tools`;
    if (chip) {
      chip.title = `${info.artifact.path}\n${info.artifact.bytes.toLocaleString()} bytes\nsha256 ${info.artifact.sha256}\nprotocol ${info.protocolVersion}`;
    }
  } catch (error) {
    if (chip) chip.dataset.state = "down";
    if (text) text.textContent = "Plugin unreachable";
    if (chip) chip.title = error?.message ?? "The backend is not responding.";
  }
}

checkPlugin();
renderRoute(location.pathname in routes ? location.pathname : "/");
