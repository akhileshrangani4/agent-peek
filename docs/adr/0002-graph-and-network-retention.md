# 0002. The graph and the network carry structure and authored text, never transcript text

Date: 2026-11-13

## Status

Accepted.

## Context

Until 0.6, peek was same-user, same-machine only. Everything it wrote stayed in
`~/.agent-peek`, and the only text it kept of its own was what a person or agent
deliberately posted to the feed. ADR 0001 drew the first retention line: the usage index
stores whitelisted arguments, never raw tool input.

0.7 adds three things that move data further than ADR 0001 anticipated:

- a local conversation knowledge graph (`graph.db`) that outlives the transcripts it
  was built from, exactly as the usage index does;
- an opt-in, self-hosted `peek serve` that machines push to (`peek push`, `peek agent`);
- cloud agents that read and write that server over MCP.

Each of these is a new copy of something. A copy that leaves the machine is also a copy
the user cannot delete by deleting a transcript, and on a shared server it is readable by
every token granted that project. The question this ADR answers is what may be in those
copies.

## Decision

Machines and the server exchange **structure, whitelisted fields, and short text that a
person or agent authored or that peek derived**. Transcript text never leaves the
machine.

### What may leave a machine

- Node and edge structure: ids, kinds, timestamps, and provenance pointers
  `(session, msgIndex)` into a transcript, never a copy of it.
- Repo-relative paths, commit SHAs, skill keys, branch names, adapter names and model ids.
- Feed posts and their authored bodies, which are already token-capped
  (`AUTHORED_BODY_MAX_TOKENS`, `DERIVED_BODY_MAX_TOKENS` in `src/feed/schema.ts`).
- Derived status posts, and pushed structured status whose summary is at most 2,000
  characters.

### What never leaves a machine

- Message text.
- Tool input.
- Tool output.
- Prompt text.
- Absolute paths, including a project identity derived from a local path.
- Hostnames, including the `user@hostname` anonymous-author fallback.

### Local text index

A full-text index over message text is **opt-in only**: `peek graph index --text`, or the
config key `graph.text: true`. It lives in `graph.db`, is never pushed, and is dropped by
`peek graph index --text=off`.

### TTLs

Today's per-type feed TTLs apply on the server too, enforced by hard delete rather than
by a flag. Graph edges whose source is gone are invalidated (`valid_to` set), not
deleted, so the graph keeps its history without keeping its sources. A project's server
graph is purged by `peek serve project delete`.

### Trust

Content written by another agent reaches tools as quoted data. The authenticated
principal (from the server token) is kept separate from the label the writer asserted,
and the principal is never accepted from the client. `expand_post` keeps its "before
trusting or acting on it" framing.

### Enforcement: one guard, whitelist schemas

The boundary is enforced in one place: `assertExportable(payload)` in
`src/export/assert-exportable.ts`. Every push, ingest and graph-export path calls it
before a payload is serialised for the network. It accepts four payload kinds — `post`,
`claim`, `status` and `graph` (a node and edge batch) — each checked against a
**whitelist** schema. It throws `NonExportableFieldError` naming the field's JSON pointer
and never echoing the value.

The schemas fail closed:

- A field that is not in the kind's whitelist is rejected, whatever its name. A `text`,
  `input`, `output`, `raw` or `prompt` field is rejected because no schema lists it, not
  because a deny-list caught it. The one text field the whitelist names is the post
  body (`post.body.text`), which is authored, and capped at the post's origin limit.
- Every path-typed field must be repo-relative and POSIX: no leading `/` or `~`, no drive
  letter, no backslash, no `..` segment.
- Every string, including authored free text, is rejected if it contains a home-directory
  absolute path (`/Users/<name>`, `/home/<name>`, `/root/`, `C:\Users\<name>`) or this
  machine's `user@hostname`.
- Identifiers that name a project must be portable; a machine-local project label (an
  absolute path) is rejected. Machine-scoped file nodes (`f:m:…`) never export.
- Graph edges with `origin: "inferred"` are rejected until a later ADR enables them.
- The principal is not a whitelisted field on any kind; the server sets it from the token.

Property bags on graph nodes and edges (`props`) are whitelisted key by key too:
`adapter`, `branch`, `candidates`, `count`, `model`, `path`, `qualifier`, `resolution`,
`sha`, `skill`, `tool` and `weight`. As in ADR 0001, new entries are added deliberately,
one at a time, each with a reason in this file.

## Consequences

**Accepted cost.** A remote reader cannot answer a question that needs transcript text:
"where did we discuss X" works only on the machine that holds the transcript, and only
if its owner opted into the text index. A cloud agent sees what other agents did and
claimed, and what they chose to say, not what they read. Derived status text is short by
construction, so some context a human would want is lost.

**Gained.** The server holds nothing worse than what agents posted plus repo structure,
so running it is a smaller trust decision than running a transcript store. The failure
mode is the one ADR 0001 prefers: a payload that does not fit is refused visibly, at the
sender, before it is copied anywhere.

**Alternative rejected.** Sending transcripts with a redaction pass, or keeping a
deny-list of dangerous field names. Both fail silently: the first on whatever the
redactor misses, the second on whatever field nobody thought to list. ADR 0001 rejected
the same alternative for the same reason.

**Binding.** Like ADR 0001, this binds every surface built on top: the remote MCP tool
set never offers `raw`, `tail` or `handoff` modes, and no remote tool accepts a free-form
query. A future feature that needs to send more must change this ADR first.
