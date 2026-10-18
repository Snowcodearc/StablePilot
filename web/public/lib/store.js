// Local persistence for demo state: the figures you last typed, the last plan
// the plugin produced, and a log of tool calls.
//
// This is browser storage, not a ledger. Nothing here is authoritative, and the
// interface says so wherever it shows this data.

const KEY = "stablepilot.web.v1";
const ACTIVITY_LIMIT = 60;

export const defaultSettings = {
  totalUsdc: "",
  spendingUsdc: "",
  savingsUsdc: "",
  emergencyReserveUsdc: "",
  savingsGoalUsdc: "",
  maxPaymentUsdc: "",
  minEmergencyReserveUsdc: "",
  recipient: "",
  chain: "base",
  explain: true,
  smartSplitAmount: "",
};

function blank() {
  return {
    settings: { ...defaultSettings },
    lastPlan: null,
    lastReport: null,
    activity: [],
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    return {
      settings: { ...defaultSettings, ...(parsed.settings ?? {}) },
      lastPlan: parsed.lastPlan ?? null,
      lastReport: parsed.lastReport ?? null,
      activity: Array.isArray(parsed.activity) ? parsed.activity.slice(0, ACTIVITY_LIMIT) : [],
    };
  } catch {
    return blank();
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // A full or disabled localStorage must not break the app; the data is a
    // convenience, and the UI keeps working without it.
  }
}

export function getSettings() {
  return { ...state.settings };
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
  return getSettings();
}

export function getLastPlan() {
  return state.lastPlan;
}

export function setLastPlan(plan) {
  state.lastPlan = plan;
  persist();
}

export function getLastReport() {
  return state.lastReport;
}

export function setLastReport(report) {
  state.lastReport = report;
  persist();
}

/** Records one tool call. Newest first, capped so storage stays small. */
export function addActivity(entry) {
  state.activity.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...entry,
  });
  state.activity = state.activity.slice(0, ACTIVITY_LIMIT);
  persist();
  return state.activity;
}

export function getActivity() {
  return [...state.activity];
}

export function clearActivity() {
  state.activity = [];
  persist();
}

export function clearAll() {
  state = blank();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** True when the four figures needed for a plan are present and well formed. */
export function hasPlanFigures(settings = getSettings()) {
  return ["totalUsdc", "spendingUsdc", "savingsUsdc", "emergencyReserveUsdc"].every(
    (key) => String(settings[key] ?? "").trim() !== "",
  );
}

/** The four figures as tool arguments, omitting empty optional fields. */
export function planArguments(settings = getSettings()) {
  const args = {
    totalUsdc: String(settings.totalUsdc).trim(),
    spendingUsdc: String(settings.spendingUsdc).trim(),
    savingsUsdc: String(settings.savingsUsdc).trim(),
    emergencyReserveUsdc: String(settings.emergencyReserveUsdc).trim(),
  };
  const goal = String(settings.savingsGoalUsdc ?? "").trim();
  if (goal) args.savingsGoalUsdc = goal;
  if (settings.explain === false) args.explain = false;
  return args;
}
