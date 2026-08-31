# 0001. The usage index stores whitelisted arguments, never raw tool input

Date: 2026-08-30

## Status

Accepted.

## Context

`peek usage` is backed by a durable index at `~/.agent-peek/usage.db`, built by scanning
local agent transcripts and recording one row per invocation.

The index is deliberately designed to **outlive its sources**. Claude Code deletes
transcripts after 30 days (`cleanupPeriodDays`), and on the machine this was designed
against the split is exact: every registry entry whose transcript is missing is 30+ days
old, every surviving one is under 30 days. Once a session's invocations are recorded,
the index is the only remaining evidence that session ever happened.

Every invocation carries an `input` payload. Storing it whole is the obvious choice for
queryability: it costs nothing at scan time, and it means no future question is
foreclosed by a dimension nobody thought to extract.

But those payloads contain Bash command lines, absolute file paths, prompt text, and
occasionally credentials. Combined with the durability above, storing them whole would
make peek the permanent copy of material the host agent deliberately deletes — created
silently, in a file the user never asked for, and surviving long after the user believes
the transcript is gone.

## Decision

The index stores the tool name plus a small set of **named, whitelisted arguments**
extracted per tool. It never stores the raw `input` blob, and never a truncated prefix
of it.

The whitelist today:

- `Skill` -> the `skill` argument
- slash commands -> the command name only, never the surrounding user message
- future entries (MCP server/tool, subagent type) are added deliberately, one at a time

This boundary is enforced in one place: the narrow typed query API that is the only
public way to read the index. **It binds any MCP surface built over usage data** — an
MCP tool must not re-expose what the schema declined to store.

## Consequences

**Accepted cost.** A question needing an argument outside the whitelist cannot be
answered for sessions whose transcripts have expired. Adding a whitelist entry and
rescanning recovers only the last 30 days; it is not a full recovery, and that limit
must be stated whenever the escape hatch is invoked as a justification.

**Gained.** peek never has to defend a data-retention decision the user did not make.
The index stays small, and the surface an MCP client can reach is bounded by the schema
rather than by each caller's judgement.

**Alternative rejected.** Storing full inputs with a redaction pass. Redaction is a
best-effort filter over unbounded text; the failure mode is silent, permanent, and only
discovered after the material has already been retained. A whitelist fails the other
way — visibly, by not having the data — which is the direction this project prefers to
fail in.

## Addendum (ticket 08): the MCP surface is not judged by CLI parity

The naive reading of this ADR is "an MCP tool may expose whatever the CLI prints." That
test is wrong, and ticket 08 rejected it.

The CLI is run by someone who already has the files: printing an aggregate to their
terminal tells them nothing they could not read from their own disk. An MCP tool is a
channel into a session that may not have those files, and whose caller is a model rather
than the person whose transcripts these are. So the boundary is the schema, not the
terminal: tools return aggregates and whitelisted arguments only — never transcript text,
message content, or a raw invocation row — and no tool accepts SQL, a free-form query, or
a filesystem path. Every read goes through the narrow query API, which is where this
retention boundary is enforced.

Two consequences worth stating, because both were nearly violated by accident:

- **No tool builds the index.** A first scan writes tens of megabytes after reading every
  transcript. A missing index returns a state and a hint to run the CLI once; it never
  bootstraps inside someone else's session.
- **No tool mutates.** `archive_plan` returns what archiving would do plus the command a
  human runs. Dry-run-by-default works because a person reads the plan, and an argument
  named `confirm` is set by the model, not the user — so the safeguard does not survive
  the MCP boundary, and the mutating half stays in the CLI.
