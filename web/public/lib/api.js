// Thin client for the local backend, which in turn drives the real plugin over
// MCP stdio. Every figure shown in the interface comes back through here.

export class ApiError extends Error {
  constructor(message, { code = "request_failed", status = 0, stderr = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.stderr = stderr;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...options,
    });
  } catch (cause) {
    throw new ApiError("Could not reach the StablePilot backend. Is `node web/server/index.mjs` running?", {
      code: "offline",
    });
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("The backend returned a response that was not JSON.", {
      code: "bad_response",
      status: response.status,
    });
  }

  if (!response.ok) {
    throw new ApiError(payload.error ?? `Request failed with status ${response.status}.`, {
      code: payload.code ?? "request_failed",
      status: response.status,
      stderr: payload.stderr ?? "",
    });
  }

  return payload;
}

/** Confirms the backend can see and start the plugin. */
export function health() {
  return request("/api/health");
}

/** Real `tools/list`, used by Settings and at startup. */
export function tools() {
  return request("/api/tools");
}

/**
 * Real `tools/call`.
 * Resolves with `{ result, durationMs }`; a plugin-level refusal arrives as
 * `result.isError === true` and is not an exception, because it is a valid
 * answer that the UI must display rather than a transport failure.
 */
export function callTool(name, args) {
  return request(`/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify({ arguments: args }),
  });
}
