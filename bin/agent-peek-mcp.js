#!/usr/bin/env node
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`error: unsupported_node\nmessage: agent-peek requires Node >= 24 (found ${process.versions.node}).\nhint: Install Node 24 LTS (e.g. nvm install 24).`);
  process.exit(5);
}

import("../dist/mcp/index.js").then((m) => m.run()).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
