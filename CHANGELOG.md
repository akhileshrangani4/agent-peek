# Changelog

## 0.5.0

Skill usage analytics: `peek usage` and `peek skills`, backed by a durable index,
with an MCP surface and a terminal picker.

The features are easy to describe. What makes them trustworthy is a set of findings
about *when a usage number lies*, and those are the substance of this release — a tool
that confidently recommends deleting a skill you rely on is worse than no tool.

### Terminal output

Every static report — `skills`, `usage`, `agents`, `list`, `doctor` — renders through one
module. Status is structure rather than a repeated column: usage segments, agent presence,
session status and adapter readiness each group under a rule, so the shape is visible
without counting rows.

Colour carries meaning and is never the only thing that does: the four coverage states
stay legible in monochrome, in a pipe, and to a reader who has not learned a palette.
No escape codes are emitted off a TTY, `--color` forces them through a pipe for a pager,
`NO_COLOR` is honoured, and every command accepts `--width`. Output fills the terminal
and degrades at 80 columns rather than targeting it.

Sparklines in `skills` and `usage` show the shape of use over time, which is the
keep-or-delete judgement a bare count cannot convey — a skill invoked once in a burst
looks nothing like one invoked steadily. `usage --by day` renders the corpus as a single
shape, since that is the one view where time is the answer rather than a decoration.

### What the numbers cannot tell you, and how peek says so

**Usage history is a rolling window, and its length differs per agent.** Claude Code
deletes session transcripts after 30 days; Codex does not delete at all. On the machine
this was built against that is **33 days of Claude Code beside 334 days of Codex**, so a
single combined figure would badly overstate coverage for the agent whose history is
capped. `peek usage` prints one line per adapter, and a count means "in the observed
window", not "ever". The index is durable precisely so history accumulates from first run
even as its sources expire.

**Three of eight agents cannot be observed at all, and a zero on those is not a zero.**
peek can attribute an invocation to a skill only where it can read transcripts *and* the
invocation names the skill. Where it cannot, it prints **`unknown`**, never `0`, and
excludes the row from bulk actions. A skill is offered for archiving only when *every*
installation is attributable — zero observed where peek can see, plus unknown where it
cannot, sums to unknown.

**Cost is an estimate and an upper bound**, computed from each skill's frontmatter and
charged once per agent that lists it; some hosts list a name without its description.
The basis is printed with the number. Skills carrying `disable-model-invocation` cost
**nothing** on agents that honour it — and can never appear in tool-call data at all, so
a usage tool reading only tool calls reports every one of them as unused.

**peek was blind to 32% of Claude Code transcripts.** Subagent transcripts live in a
sidecar directory beside their parent's and were never scanned. That was not only a usage
gap: **`peek check` and `peek claim` could not see subagents** — the agents most likely
to conflict, since a long-running session fans out to subagents that do the actual
editing. Measured across the corpus, subagents wrote 164 distinct paths and their parents
wrote 6 of them; 158 existed in no other transcript. Conflict detection now sees them.

### Added

- `peek usage` — durable, cross-agent invocation index under `~/.agent-peek/`. Filters
  and groupings for tool, skill, agent, adapter, day, cwd, invocation kind, subagent and
  attribution; every filter is also a grouping. JSON returns an envelope carrying
  coverage and window, never a bare array.
- `peek skills` — inventory across every agent root, segmented by what is actionable, with
  `--interactive` to browse and mark, and `--skill <name>` to see every installation and
  what archiving each would do.
- `peek skills archive` / `restore` — per installation, dry run by default.
- `peek agents` — the agent registry, with user-defined agents via
  `~/.agent-peek/agents.json`.
- MCP tools for usage, skills, agents and archive planning. Read-only.
- Subagent session discovery, hidden from `peek list` by default behind
  `--include-subagents`, but included in coordination and the index.
- Codex slash-command extraction.

### Changed

- `peek list` output is unchanged by default despite subagent discovery.
- Display names mark subagent sessions, which share their parent's working directory.

### What this release deliberately does not do

- **Never edits another application's configuration file**, including agent config
  directories and `settings.json`.
- **Never disables a plugin.** Plugin skills are reported for cost and never mutated;
  disabling one stays a `/plugin` action the user takes.
- **Never mutates through MCP.** The MCP surface is read-only, including archive
  *planning*, which describes and does not act.
- **Never archives without an explicit confirm.** Every destructive path is a dry run
  until `--yes`, and names each installation it would touch and each it would skip.

## 0.4.0 and earlier

See the git history.
