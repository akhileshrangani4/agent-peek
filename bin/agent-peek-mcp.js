#!/usr/bin/env node
import("../dist/mcp/index.js").then((m) => m.run()).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
