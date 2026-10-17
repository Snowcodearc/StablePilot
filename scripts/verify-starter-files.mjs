// Prove that the files adopted from the official PayBox plugin starter are the
// official bytes, not a mixture of releases.
//
// The requirement document says the release is identified by file checksums
// ("./plugin-starter/v1.0.2/manifest.json") and warns: "Replace all tooling
// files together; do not mix starter releases." This checks exactly that.
//
// The reference manifest is kept in `.paybox-starter/`, the pristine copy of
// the downloaded starter. If that directory is absent the check reports
// "skipped" rather than failing, because it is a provenance check about
// development, not a property of the shipped artifact.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const manifestPath = resolve(root, ".paybox-starter", "manifest.json");

/**
 * Files intentionally changed after adoption. Each needs a reason; this is the
 * whole list of permitted deltas.
 */
const INTENTIONAL = {
  "package.json": "renamed to stablepilot and given project scripts; dependencies, engines and packageManager are untouched",
  "paybox-plugin.json": "must carry StablePilot's own sample invocation",
  "src/plugin.ts": "the starter's echo tool is meant to be replaced by the plugin's tools",
  ".gitignore": "unchanged in content; listed here only if the starter's copy differs",
};

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "no .paybox-starter/manifest.json to compare against" })}\n`);
  process.exit(0);
}

const matching = [];
const changed = [];
const missing = [];
const unexplained = [];

for (const [file, expected] of Object.entries(manifest.files)) {
  let actual;
  try {
    actual = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  } catch {
    missing.push(file);
    continue;
  }
  if (actual === expected) {
    matching.push(file);
  } else if (file in INTENTIONAL) {
    changed.push({ file, reason: INTENTIONAL[file] });
  } else {
    unexplained.push(file);
  }
}

const ok = missing.length === 0 && unexplained.length === 0;
process.stdout.write(
  `${JSON.stringify(
    {
      status: ok ? "passed" : "failed",
      starterVersion: manifest.version,
      protocolVersion: manifest.protocolVersion,
      intact: matching.length,
      intentionallyChanged: changed,
      missing,
      unexplainedChanges: unexplained,
    },
    null,
    2,
  )}\n`,
);
if (!ok) process.exitCode = 1;
