// src/app/engine.ts
//
// The engine's composition root: a registry, a claims store and an adapter set, wired
// together. Every front end (CLI, stdio MCP, the TUI and the future HTTP host) builds
// its engine here, so adapter registration exists in exactly one place.
import { ClaimsStore } from "../core/claims.js";
import { Engine } from "../core/engine.js";
import { Registry } from "../core/registry.js";
import { createAdapterLoader } from "./adapters.js";

export interface CreateEngineOpts {
  home?: string;
  withBuiltins?: boolean;
  withExternal?: boolean;
}

export async function createEngine(opts: CreateEngineOpts = {}): Promise<Engine> {
  const registry = new Registry({ home: opts.home });
  const claims = new ClaimsStore({ home: opts.home });
  const loader = await createAdapterLoader({ withBuiltins: opts.withBuiltins, withExternal: opts.withExternal });
  return new Engine({ registry, loader, claims });
}
