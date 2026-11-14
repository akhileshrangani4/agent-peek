// src/adapters/types.ts
//
// The `agent-peek/adapter` entry point. The contract itself lives in core/types so the
// engine can depend on it without importing anything from src/adapters; this module
// keeps the published plugin ABI where third-party adapters already import it from.
export type { Adapter, AdapterReadResult, AdapterModule } from "../core/types.js";
