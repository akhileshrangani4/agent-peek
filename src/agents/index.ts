// src/agents/index.ts
export type {
  Agent, InvocationKind, ResolvedAgent, ResolvedSkillRoot, SkillRoot, SkillRootKind,
} from "./types.js";
export { adapterObserves, builtinAgents, sharedLibraryRoot } from "./builtin.js";
export type { HomeEnv } from "./builtin.js";
export type { AgentRegistryOptions } from "./registry.js";
export {
  addAgent, isPresent, listAgents, mergeAgents, readUserAgents, removeAgent, resolveAgent,
} from "./registry.js";
