# agent-peek

peek observes coding agents running on one machine: what sessions exist, what they are
doing, and which skills they actually reach for. This glossary fixes the vocabulary
shared by session reading, the usage index, and skill inventory.

## Language

### Agents and adapters

**Agent**:
A coding agent product installed on this machine, identified by a product slug
(`claude-code`, `codex`, `cursor`, `gemini`, `opencode`, `goose`, `continue`, `factory`).
An agent has zero or more skill roots and at most one adapter.
_Avoid_: client, tool, assistant

**Adapter**:
A parser for one transcript format, named for the format it reads. Adapters are
orthogonal to agents: `screen` and `tmux` read sessions but belong to no agent, and
`cursor`, `continue`, and `factory` are agents with no adapter.
_Avoid_: driver, provider, backend

**Skill root**:
A directory an agent reads skills from, declared as a candidate path and resolved
against disk. Each root has a kind (`user`, `plugin`, `project`) and is mutable or not;
plugin roots are read-only.
_Avoid_: skills dir, skills folder

**Shared library root**:
`~/.agents/skills` — a root that no agent's system prompt reads directly, holding the
skill directories that per-agent roots symlink into. It is a foreign installer's
territory: peek reads it and does not write it.
_Avoid_: central skills, the agents dir

**Observable**:
Derived, never stored: an agent is observable when its adapter is present and can
extract at least one invocation kind. Observability is a property of the parser, not the
product, so an agent may be observable for one invocation kind and blind to another.
_Avoid_: readable, supported

**Manageable**:
Derived, never stored: an agent is manageable when at least one of its resolved skill
roots exists and is mutable. An unmanageable agent is reported and never mutated.
_Avoid_: writable, editable

### Skills and their use

**Skill**:
A unit of instruction an agent can load, identified by the directory holding its
`SKILL.md`. One skill directory reached from five agents is one skill.
_Avoid_: command, plugin, capability

**Installation**:
One agent's access to one skill, via a real directory or a symlink inside one of that
agent's skill roots. A skill has one or more installations; removing one is not removing
the skill.
_Avoid_: copy, link, entry

**Invocation**:
One occasion on which a skill was loaded, however it was reached. It covers both
invocation kinds; a skill with zero tool calls and many slash commands has been used.
_Avoid_: tool call, usage event, run

**Invocation kind**:
How the invocation was expressed: `tool_call` (the `Skill` tool, in an assistant
message) or `slash_command` (in a user message, and the only path available to a skill
carrying `disable-model-invocation`).
_Avoid_: source, type, channel

**Initiator**:
Who reached for the skill, orthogonal to invocation kind: the human (slash command), the
main agent loop, or a subagent. Subagent-initiated use marks a skill as a dependency of
a workflow rather than a habit of the user.
_Avoid_: caller, actor, origin
