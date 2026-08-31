// src/agents/index.ts
export type {
  Agent, AgentTier, GeneratedAgent, InvocationKind, ResolvedAgent, ResolvedSkillRoot,
  SkillRoot, SkillRootKind,
} from "./types.js";
export {
  adapterObserves, builtinAgents, sharedLibraryRoot, sharedLibraryRoots, AGENT_TABLE_SOURCE,
} from "./builtin.js";
export type { HomeEnv } from "./builtin.js";
export { GENERATED_AGENTS, GENERATED_SOURCE } from "./generated-agents.js";
export type { AgentRegistryOptions } from "./registry.js";
export {
  addAgent, isPresent, listAgents, mergeAgents, readUserAgents, removeAgent, resolveAgent,
} from "./registry.js";
