#!/usr/bin/env node
// scripts/extract-agent-table.mjs
//
// Regenerates src/agents/generated-agents.ts from the `skills` installer's agent table
// (https://github.com/vercel-labs/skills). peek has verified only the handful of agents
// its authors run locally; every entry this produces is therefore marked `sourced`, not
// `verified`, and self-verifies on a user's machine by resolving against disk or not.
//
// Usage:
//   node scripts/extract-agent-table.mjs <path-to-skills/dist/cli.mjs>
//
// Get the source with: npm pack skills@<version> (or point at an npx cache copy).
// Re-run and `git diff` to audit the table against a newer installer release.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/extract-agent-table.mjs <path-to-skills/dist/cli.mjs>");
  process.exit(2);
}
const text = readFileSync(source, "utf8");
const sha = createHash("sha256").update(text).digest("hex");

let version = "unknown";
try {
  version = JSON.parse(readFileSync(join(dirname(dirname(resolve(source))), "package.json"), "utf8")).version;
} catch { /* version stays unknown; the hash still identifies the input */ }

// Home-directory variables the installer resolves before joining. Kept as placeholders so
// peek resolves them itself, honouring the same environment overrides.
const BASES = {
  home: "{home}",
  configHome: "{config}",
  claudeHome: "{claude}",
  codexHome: "{codex}",
  grokHome: "{grok}",
  vibeHome: "{vibe}",
  hermesHome: "{hermes}",
  autohandHome: "{autohand}",
};

// Some entries carry extra flags (showInUniversalPrompt, showInUniversalList) between
// globalSkillsDir and detectInstalled; tolerate any fields in between.
const ENTRY = /"?([a-z0-9-]+)"?:\s*\{\s*name:\s*"([a-z0-9-]+)",\s*displayName:\s*"([^"]+)",\s*skillsDir:\s*"([^"]+)",\s*globalSkillsDir:\s*(.*?),\s*(?:[A-Za-z]\w*:\s*[^,]*,\s*)*?detectInstalled:\s*(.*?)\n\t*\}/gs;

/** `universal` is the installer's own write-everywhere target (its detect always returns
 * false), not a coding agent. In peek's model that tree is the shared library root. */
const NOT_AN_AGENT = new Set(["universal"]);

const agents = [];
for (const match of text.matchAll(ENTRY)) {
  const [, , slug, displayName, projectDir, globalExpr, detectExpr] = match;
  if (NOT_AN_AGENT.has(slug)) continue;
  agents.push({
    slug,
    displayName,
    projectDir,
    globalRoot: parseGlobal(globalExpr.trim()),
    detectPaths: parseDetect(detectExpr ?? ""),
  });
}

/** `join(home, ".claude/skills")` and friends → "{home}/.claude/skills". A call peek
 * cannot evaluate (a helper function, or `void 0`) yields undefined: the agent is
 * declared with no root convention rather than with a guessed one. */
function parseGlobal(expr) {
  const call = expr.match(/^join\(\s*([A-Za-z_$][\w$]*)\s*,\s*(.+)\)$/s);
  if (!call) return undefined;
  const base = BASES[call[1]];
  if (!base) return undefined;
  const parts = call[2].split(",").map((p) => p.trim());
  const segments = [];
  for (const part of parts) {
    const literal = part.match(/^"([^"]*)"$/);
    if (!literal) return undefined;
    segments.push(literal[1]);
  }
  return [base, ...segments].join("/").replace(/\/+/g, "/");
}

/**
 * The installer proves an agent is installed by looking for its own directory, e.g.
 * `existsSync(join(home, ".amp"))`. peek needs this because several agents' skill root is
 * the *shared* tree: that directory existing says nothing about whether the agent is
 * installed, so the agent's own directory is the only honest evidence.
 */
function parseDetect(expr) {
  const paths = [];
  for (const call of expr.matchAll(/existsSync\(\s*join\(\s*([A-Za-z_$][\w$]*)\s*,\s*([^)]*)\)\s*\)/g)) {
    const base = BASES[call[1]] ?? (call[1] === "process" ? undefined : undefined);
    if (!base) continue;
    const segments = [];
    let ok = true;
    for (const part of call[2].split(",").map((p) => p.trim())) {
      const literal = part.match(/^"([^"]*)"$/);
      if (!literal) { ok = false; break; }
      segments.push(literal[1]);
    }
    if (ok) paths.push([base, ...segments].join("/").replace(/\/+/g, "/"));
  }
  return paths.length ? paths : undefined;
}

agents.sort((a, b) => a.slug.localeCompare(b.slug));
const withRoot = agents.filter((a) => a.globalRoot).length;

const header = `// src/agents/generated-agents.ts
//
// GENERATED FILE — do not edit by hand.
// Regenerate: node scripts/extract-agent-table.mjs <path-to-skills/dist/cli.mjs>
//
// Source:     npm package \`skills\` (https://github.com/vercel-labs/skills)
// Version:    ${version}
// SHA-256:    ${sha}
// Extracted:  ${new Date().toISOString().slice(0, 10)}
// Entries:    ${agents.length} agents, ${withRoot} with a resolvable global skill root,\n//             ${agents.filter((a) => a.detectPaths).length} with an install-detection path
//
// The source file lives inside an npm package, not at a stable path on any machine;
// fetch it with \`npm pack skills@${version}\` to re-derive and diff this table.
//
// Every entry here is \`sourced\`: taken from a third-party table and never verified by
// peek. Corrections belong in the overlay in ./builtin.ts, which wins over this file, so
// a regeneration cannot silently revert them.
import type { GeneratedAgent } from "./types.js";

export const GENERATED_SOURCE = {
  package: "skills",
  version: "${version}",
  sha256: "${sha}",
  extracted: "${new Date().toISOString().slice(0, 10)}",
} as const;

export const GENERATED_AGENTS: GeneratedAgent[] = ${JSON.stringify(agents, null, 2)};
`;

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "agents", "generated-agents.ts");
writeFileSync(out, header, "utf8");
console.log(`wrote ${agents.length} agents (${withRoot} with a root) to ${out}`);
