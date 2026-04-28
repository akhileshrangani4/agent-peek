#!/usr/bin/env node
import("../dist/cli/index.js").then((m) => m.run()).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
