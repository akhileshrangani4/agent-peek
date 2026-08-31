#!/usr/bin/env node
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`error: unsupported_node\nmessage: agent-peek requires Node >= 24 (found ${process.versions.node}).\nhint: Install Node 24 LTS (e.g. nvm install 24).`);
  process.exit(5);
}

// node:sqlite emits an ExperimentalWarning on every import, so a read-only command that
// touches the usage index printed two lines of Node internals above its own output. Drop
// that one warning and keep every other: removing the default listener silences all of
// them, so the filtered listener re-prints anything else exactly as Node would.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.error(`(node:${process.pid}) [${w.name}] ${w.message}`);
});

import("../dist/mcp/index.js").then((m) => m.run()).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
