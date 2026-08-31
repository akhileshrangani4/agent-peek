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

**Shared tree**:
A root holding skill directories that other agents' roots symlink into. Two exist:
`~/.agents/skills` and `~/.config/agents/skills`. Some agents read a shared tree
directly rather than linking into it, so it can be an agent's own root — but its content
backs every other agent's links, so peek reports it and never moves it.
_Avoid_: shared library root, central skills, the agents dir

**Tier**:
How much peek knows about an agent entry it ships: `verified` means peek has resolved
that agent's root on a machine that had it; `sourced` means the entry comes from a named
third-party table and peek has never confirmed it. A sourced entry self-verifies on a
user's machine by resolving, or not.
_Avoid_: trusted, official, confidence

**Presence**:
Whether an agent is on this machine: `present` (its own directory or a non-shared root
resolved), `absent` (peek knows the convention, nothing is here), `no-convention` (peek
knows the agent exists but has no root path for it). A shared tree existing is never
evidence an agent is installed.
_Avoid_: installed, available, detected

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

**Model-invocable**:
Whether an agent may reach a skill on its own. Frontmatter can withhold a skill from the
model, leaving the slash command as its only path. A skill withheld this way is not
listed, so it is charged nothing.
_Avoid_: enabled, auto, visible

**Cost**:
What an agent's system prompt pays per turn to list a skill: its name and description,
not what the file contains. Charged once per agent that lists it, and always an estimate
with a stated basis rather than a measurement.
_Avoid_: size, weight, tokens

**Archive**:
Removing a skill from an agent without destroying it. Two acts on disk, derived from the
installation and never configured: unlinking an installation whose content lives
elsewhere, or moving an installation that *is* the content. Reversible by restore.
_Avoid_: prune, delete, remove, uninstall

**Retire**:
Archiving every one of a skill's installations, so no agent reaches it. Distinct from
archiving one installation; peek refuses to guess which was meant.
_Avoid_: purge, remove everywhere

**Initiator**:
Who reached for the skill, orthogonal to invocation kind: the human (slash command), the
main agent loop, or a subagent. Subagent-initiated use marks a skill as a dependency of
a workflow rather than a habit of the user.
_Avoid_: caller, actor, origin

## Durability

The usage index is durable because it must be: transcripts are deleted at 30 days, so
once a session's invocations are recorded, the index is the only remaining evidence the
session happened. The inventory is live because it can be: skill roots are not deleted
out from under it, so it is walked fresh on every command and never cached.
