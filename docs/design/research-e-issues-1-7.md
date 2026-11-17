# Research E — open issues #1–#7

Read-only research. On 2026-11-13 the owner asked for all seven open agent-peek issues to be done in 0.7. This document reproduces each issue on `release/0.7.0`, cites the code that causes it, proposes a fix with acceptance criteria, and maps it against the approved spec ([spec-0.7.md](spec-0.7.md)). No repository files were changed and no PR was opened.

**Baseline.** `origin/release/0.7.0` at `5e40e0e` (PR #16, the golden parity harness), checked out as a detached worktree and built under Node v24.22.3. The handoff, snapshot, coordination and golden suites pass on that baseline (5 files, 128 tests). Line numbers below refer to that commit.

**How the issues were reproduced.** All seven issues were filed on 2026-06-25, against code older than 0.6.0. Eleven commits on 2026-09-14 then partly addressed them: `d9c4ca7` and `517e025` (task inference), `1625fe3` (scraped paths must exist, questions must be questions), `c8cb9f8` (actions scoped to the current ask) and `1b5e67d` (branch and recent commands in the local handoff). So every reproduction below runs against the release branch, not the original reports. Two harnesses were used:

- `repro.mjs` calls the built library (`toHandoff`, `toStructured`, `toBrief`) on hand-built `RawMessage` fixtures inside a temp workspace with real files. It covers #1, #2, #3, #6 and #7.
- `repro5.sh` builds a fake `$HOME` with one Claude Code parent transcript and two subagent sidecars, then runs the built `peek` CLI. It covers #4 and #5.

Both scripts were scratch files on the repo sandbox and are not committed. Their outputs are quoted below. The proposed tests rebuild the same fixtures under `test/`.

> **Load-bearing assumption:** the issues assume a resuming agent acts on every handoff field. If so, wrong or stale fields cost more than missing ones, and making fields accurate and structured is what makes resuming faster. That matches how the issues describe agent behaviour, but nobody has measured it. One way to check: after these PRs land, run a resume on a real long session with the old handoff and the new one, and count the turns the agent spends on dead paths or already-answered questions. A cause the issues don't mention: the model-written (`harness`) handoff gets the regex fields as "hints" (`renderHandoffPrompt`, `src/core/handoff.ts:281-319`), so wrong hints can leak into the model's document too. Fixing the extractors fixes both paths.

## Summary

| # | Reproduced on release/0.7.0? | Root cause (short) | Changes existing golden values? | Proposed PR |
|---|---|---|---|---|
| 1 | Yes | Files are the union of every path any call touched. Questions are scanned over the whole transcript with no "was it answered" check. | No. Fixture lists are empty. | E1 (files), E2 (questions) |
| 2 | Yes, partly. "Anything else?" is now filtered. | Decisions match on broad verbs (`using`, `added`). A question counts as open based on its wording, not on who asked it or whether it was answered. | No | E2 |
| 3 | Yes | `HandoffSnapshot` has no git field. Commit SHAs and PR URLs in tool output are never parsed. | Additive key only | E3 |
| 4 | Yes | `--json` prints the generic `PeekResult` with no schema version. Files are bare strings. It spawns the agent CLI unless `--local`. | Additive keys only | E3 |
| 5 | Yes, plus a new bug | `list` is flat and there's no tree. `parentSessionId` is a bare native id while session ids are prefixed, so `check --ignore-self` from a parent flags its own subagents (exit 1). | No. The fixture home has no subagents. | E4 |
| 6 | Yes (example 2 exactly) | When the latest human turn is an acknowledgement, `inferCurrentTask` falls back to the last assistant line that looks like an objective. No field holds the session goal. | Additive key only. Current values are unchanged. | E2 |
| 7 | Yes, worse than reported | Paths resolve against the session cwd and ignore `cd dir &&` and Codex `workdir`. Real edits are dropped, or attributed to a same-named file and reported as writes. Reads and writes share one list. | No | E1 |

## Issue #1 — handoff isn't current-state-aware

**Issue.** "files listed `docs/superpowers/plans/2026-06-25-buildy-content-prompt.md` — a path that had been `git mv`'d away … `open questions` included items already answered later in the session."

**Reproduction** (`repro.mjs` §1). The fixture session asks a question, which the user answers. It then writes the plan file and `git mv`s it to `docs/plans/new-plan.md`. Finally the assistant asks "What do you think?" and the user replies "looks good, ship it".

```
touchedFiles: ["<ws>/docs/plans/new-plan.md",
               "<ws>/docs/superpowers/plans/2026-06-25-buildy-content-prompt.md"]   <- moved away; not on disk
openQuestions: ["Should I put the plan under docs/superpowers/plans or docs/plans?",  <- answered next turn
                "What do you think?"]                                                    <- answered next turn
```

**Code.**

- `toHandoff`, `src/core/handoff.ts:57-93`. `touchedFiles: inferTouchedFiles(messages, cwd)` at line 83 runs over every message. `openQuestions: extractQuestions(allText, 5)` at line 81 runs over `allText`, which is every non-system message (lines 70-72). The current-ask scoping from `c8cb9f8` (`lastHumanTurnIndex`, lines 95-101) only covers `decisions` and `nextActions`.
- `inferTouchedFiles`, `src/core/coordination.ts:354-371`, adds every path it extracts to one `Set`. A path that came from a named tool argument (Write's `file_path`) skips the `existsSync` guard at line 366, which only applies to paths scraped from commands. So a written file that was later moved or deleted stays in the list.
- `extractQuestions` / `isOpenQuestion`, `src/core/handoff.ts:564-584`, decide on wording alone. No step checks whether a later turn from the other party answered the question.

**Root cause.** Confirmed by reproduction. Files are the union of every path touched, with no fold over moves or deletes and no end-state check. Questions are scanned over the whole transcript, with no rule that an answered question is closed.

**Proposed fix.**

- **Files (E1).** Fold the session's file events in order:
  - A write marks a file modified, or created if it wasn't seen before.
  - `mv`/`git mv` marks the source `moved`, with `movedTo` set.
  - `rm`/`git rm` marks the file `deleted`. `writeTargetsOfCommand` (`coordination.ts:505-539`) already returns the destination of plain `mv`/`cp` and the operands of `rm`, as pinned by `snapshot.test.ts`. It also needs to return the move source. Whether it handles the `git mv`/`git rm` forms wasn't checked, so the fix should add explicit cases for them.
  - When the handoff is built, check each written file's end state on disk.
  - The handoff "Files" section lists live files, and puts moved or deleted files on one line each ("moved to …", "deleted"). This uses the new `files[]` from #7.
- **Questions (E2).** A question is open only if no later turn from the other party exists. An assistant question followed by a human turn is answered. A user question followed by assistant text is answered. Questions are extracted from the whole transcript, then filtered by that rule. That keeps a genuinely unanswered early blocker.

**Acceptance criteria.**

- 1a: a file written and then `git mv`'d appears once, at its destination, with the source marked `moved`. A file written and then `rm`'d is marked `deleted` and is not listed as live.
- 1b: a question followed by a reply from the other party is not in `openQuestions`. A trailing unanswered question is.
- 1c: existing snapshot, handoff and golden tests pass unchanged.

**Tests.** New cases in `test/unit/handoff.test.ts`, using the §1 fixture in a temp workspace. One case adds an early question with no answer, to prove it stays.

**Compatibility.**

- The `touchedFiles` meaning is unchanged. It's pinned by `test/unit/snapshot.test.ts:76-81`, and `coord` relies on it for `recentFiles`.
- The end state goes in the new `files[]` (see #4), which is additive.
- `openQuestions` values change for real sessions. In the goldens it's `[]` (`at-handoff-local.json`, `tool-peek-handoff.json`), so no golden value moves.
- No CLI, MCP or library break.

**Spec overlap.** No deliverable in [spec-0.7.md](spec-0.7.md) covers handoff content. The files half belongs with #7 (E1) and the questions half with #2 (E2).

## Issue #2 — conversational chrome in decisions and open questions

**Issue.** Lines like "Anything else?" and "can you not use peek to create a handoff?" showed up as open questions, and "Using peek to capture session context, then I'll write the handoff." showed up as a decision.

**Reproduction** (`repro.mjs` §2):

```
decisions:     ["Using peek to capture session context, then I'll write the handoff.",   <- narration
                "I added the handoff file."]                                              <- outcome, not a decision
openQuestions: ["can you not use peek to create a handoff?",                             <- the user's own request, answered next turn
                "Would you like me to also commit it?"]                                  <- closing offer
```

"Anything else?" is already dropped, because `isOpenQuestion` requires at least four words (`handoff.ts:582`, from `1625fe3`). The other three cases still reproduce.

**Code.**

- `toHandoff`, `handoff.ts:80`: `decisions: extractLines(assistantText, /\b(decided|decision|chose|using|implemented|added|changed|fixed|removed)\b/i, 5)`. The words `using`, `added`, `changed`, `fixed` and `removed` match progress narration and outcomes, not decisions.
- `handoff.ts:82`: `nextActions` matches `will`, `need to` and `next`. "Let me run peek at first." doesn't match today, but any "I'll now …" line does.
- `isOpenQuestion`, `handoff.ts:579-584`, accepts any line of four or more words that ends in `?` and contains `can you`, `would you` or `or`. It doesn't check the speaker, whether the question was answered, or whether it's a stock closing line.

**Root cause.** Confirmed. Lines are classified by keyword with no speaker, position or narration filter.

**Proposed fix (E2).** A pure rules pass in a new `src/core/handoff-signal.ts`, table-tested:

- **Decisions.** Require a decision shape: `decided`, `chose`, `going with`, `instead of`, `rather than`, `because`, or `we'll use X`. Drop first-person progress narration that matches `^(using|let me|now I|I'll now|I'm going to|first,? I)`. Drop bare outcomes ("I added X"). The new `files[]` and `git` fields cover those.
- **Next actions.** Apply the same narration filter, and keep lines that describe future work ("Will rewrite next." stays; the golden pins it).
- **Open questions.** Apply the answered rule from #1. Drop stock closers (`anything else`, `let me know if`, `does that (help|work)`, `want me to …?` when it's the last line of a turn that finished the task). Whether a trailing offer such as "Would you like me to also commit it?" counts as open is an owner question (Q6).

**Acceptance criteria.**

- 2a: the four §2 lines are classified as listed above.
- 2b: a fixture table of at least 20 lines (narration, outcomes, real decisions, real blockers) gets 100% expected classification.
- 2c: "Will rewrite next." stays in `nextActions`, so `at-handoff-local.json` and `tool-peek-handoff.json` are byte-identical.

**Tests.** `test/unit/handoff-signal.test.ts` (table-driven), plus the §2 fixture in `handoff.test.ts`.

**Compatibility.** Only values in real sessions change. Golden values are unchanged (`decisions: []`, `openQuestions: []`, `nextActions: ["Will rewrite next."]`). No CLI, MCP or library change.

**Spec overlap.** None. Note on the spec: D4 deliberately doesn't build `DECIDED`/`ASKED` edges from these regexes, because their labels are transcript text (ADR 0002). Better extraction doesn't change that. Handoff fields stay local.

## Issue #3 — git artifacts the session produced

**Issue.** A session that created two merged PRs, about 4 branches and about 15 commits had none of them in the handoff. The issue asks for a `git` section listing branches, PRs, commits, and the current branch with working-tree cleanliness.

**Reproduction** (`repro.mjs` §3). The fixture runs `git checkout -b feat/1578-prompts`, then `git commit` (output `[feat/1578-prompts 1a2b3c4] feat: content prompts`), then `gh pr create` (output `https://github.com/acme/buildy/pull/2067`), then `gh pr merge 2067`.

```
snapshot keys: mode, sessionId, messageCount, activity, currentTask, lastAssistantMessage, decisions,
               openQuestions, nextActions, touchedFiles, pendingTools, recentTools, target, document, provider
"2067" in any structured field: false; "1a2b3c4" anywhere in document: false
## Environment … Recent commands: `git checkout -b feat/1578-prompts` -> ok, `git commit -am …` -> ok,
                  `gh pr create --fill` -> ok, `gh pr merge 2067 --squash` -> ok
```

**Code.**

- `HandoffSnapshot`, `src/core/types.ts:127-149`, has no git field.
- `localHandoffContext`, `handoff.ts:352-385`, reads `gitBranch` only from Claude Code's `raw.gitBranch` (lines 353-360). It keeps the last 8 commands as text with an ok/failed reading (line 384). It never parses tool output for SHAs, branch names or PR URLs.
- `renderLocalHandoff`, `handoff.ts:387-437`, prints a branch line only when `gitBranch` is set (line 428).

**Root cause.** Confirmed. Nothing extracts git artifacts. The command list is capped at 8 and is unstructured.

**Proposed fix (E3).** Add a pure parser, `src/core/git-artifacts.ts`. Its input is the session's tool calls joined to their outputs: Claude Code statuses are settled, and Codex `call_id` is kept since PR #15. It returns:

```
git: {
  branches: [{ name, created: boolean, pushed: boolean }],      // checkout -b / switch -c / push -u
  commits:  [{ sha, branch?, subject? }],                       // "[branch sha] subject" lines from commit output
  prs:      [{ number, url?, state: "opened"|"merged"|"closed"|"unknown" }],  // gh pr create URL / gh pr merge|close
  head?:    { branch, dirty: number }                           // read-only `git rev-parse` + `git status --porcelain` in the session cwd at handoff time
}
```

- PR state is "as recorded in the transcript". The handoff makes no `gh` network calls (Q5).
- `head` is the one new local subprocess. It's read-only and skipped when `git` isn't present.
- The Markdown handoff gets a `## Git` section. The harness prompt's hints gain the same data.

**Acceptance criteria.**

- 3a: the §3 fixture yields one created and pushed branch, commit `1a2b3c4` with its subject, and PR 2067 marked `merged`.
- 3b: a failed `git commit` (non-zero exit, or no `[branch sha]` line) yields no commit.
- 3c: a Codex `exec_command` fixture yields the same result as the Claude Code `Bash` fixture.
- 3d: with no git calls, `git` is `{ branches: [], commits: [], prs: [] }`.
- 3e: `head` reflects a temp repo's branch and dirty count.

**Tests.** `test/unit/git-artifacts.test.ts` (pure parser), plus one `handoff.test.ts` case using a temp git repo for `head`.

**Compatibility.**

- `git` is a new key on `HandoffSnapshot` (additive, library type).
- It changes the bytes of `at-handoff-local.json` and `tool-peek-handoff.json`: one added key, and a `## Git` section added to `document`. That needs an explicit golden re-record (Q4).
- The CLI gains no flags.
- MCP `peek_session` handoff results gain the field, which is additive.

**Spec overlap.**

- **D4 `COMMITTED`.** D4 builds `COMMITTED` heuristically from "a `git commit` in Bash plus a sha in the output", and `graph_session_commits` answers "which commits came out of a session?". That's the same parse. **Recommendation:** `git-artifacts.ts` lands in E3 first, and the D4 graph-ingest task consumes it for `COMMITTED`, `ON_BRANCH` and the commit nodes rather than writing a second parser. D4 then depends on E3, and E3 depends on nothing in the spec.
- **ADR 0002.** Commit SHAs and branch names are on the exportable list. Commit subjects and PR titles are not, because they're text from tool output. They may appear in the local handoff but must not enter graph rows or pushed payloads. Add one D4.2-style canary assertion: a commit subject seeded as a canary never appears in `graph.db`.

## Issue #4 — `handoff --json` with a stable schema

**Issue.** The issue asks for `peek at <s> --mode handoff --json` to return "a stable, documented schema", for example `{session, activity, task, decisions, openQuestions, nextActions, git, files:[{path,state}], nextCursor}`.

**Reproduction** (`repro5.sh` plus a fake runner). `AGENT_PEEK_HANDOFF_RUNNER` pointed at a script that writes a flag file.

```
peek at claude-code:aaa111 --mode handoff --json
  -> provider: "harness", runner: "/tmp/repro-e/fake-runner.sh"   (flag file written: the agent CLI was spawned)
  -> snapshot keys: mode, sessionId, messageCount, activity, currentTask, decisions, openQuestions, nextActions,
                    touchedFiles, pendingTools, recentTools, target, document, provider, runner
  -> schemaVersion: undefined; touchedFiles[0]: string
```

`--json` already exists. What's missing: there's no version or documented schema, files are bare strings with no state, there's no git or goal field, and without `--local` a JSON call spawns a model for up to 180 s (`DEFAULT_RUNNER_TIMEOUT_MS`, `handoff.ts:474`) even though only `document` depends on the model.

**Code.**

- `at` command, `src/cli/index.ts:371-445`: `produce: opts.local ? "local" : "harness"` at line 413.
- `Engine.peek` handoff branch, `src/core/engine.ts:138-150`.
- `buildHandoff`, `handoff.ts:103-153`.
- `HandoffSnapshot`, `types.ts:127-149`.
- MCP `peek_session`, `src/mcp/index.ts:384-398`, always uses `produce: "material"`.

**Root cause.** Confirmed. The JSON is the internal snapshot type, not a published contract.

**Proposed fix (E3).** Publish handoff schema v1 as an additive superset of today's snapshot:

- Add `schemaVersion: 1`, `goal` (#6), `files: HandoffFile[]` (#7/#1: `{ path, relPath?, role: "wrote"|"read", state: "modified"|"created"|"deleted"|"moved", movedTo? }`) and `git` (#3).
- Keep every existing key with its current meaning: `sessionId`, `currentTask`, `touchedFiles`, and the rest. The issue's names (`session`, `task`, object-valued `files` replacing strings) would rename existing keys, which breaks the spec's additive rule. The new `files` key is new, so it doesn't collide.
- Check a JSON Schema file into the repo (`docs/schema/handoff.v1.json`) and document it.
- `nextCursor` stays on the `PeekResult` envelope, where it is today.
- Don't change the default runner behaviour (compatibility). Document that `--local --json` is the fast deterministic path, and that every field except `document` is identical between `local` and `harness`. Whether `--json` should imply `--local` is an owner question (Q3).

**Acceptance criteria.**

- 4a: output of `at --mode handoff --json` (both `--local` and harness) and MCP `peek_session` `mode=handoff` validates against `handoff.v1.json`.
- 4b: projecting each 0.6 golden onto its 0.7 output gives byte-identical values for every 0.6 key.
- 4c: with a stub runner, every field except `document`, `provider` and `runner` is deep-equal between `local` and `harness`.
- 4d: a public-API type test asserts the new fields are optional-compatible for library consumers who construct `HandoffSnapshot`.

**Tests.** A schema-validation test (any validator already in devDependencies, or a hand-written structural assertion if none is present; this was not checked), a stub-runner parity test, and the projection check in the golden suite.

**Compatibility.**

- The CLI JSON and the MCP result gain keys.
- Two goldens change by added keys and an added document section only: `cli/at-handoff-local.json` and `mcp/tool-peek-handoff.json`.
- The library type `HandoffSnapshot` gains fields. If any of them is required, external code that builds the type breaks. They should be optional in the exported type and always populated by peek.

**Spec overlap.** D5.2 already says that no remote tool accepts `mode: raw|tail|handoff` and that `peek_session` isn't registered remotely. Handoff stays local-only under ADR 0002 because `decisions`, `openQuestions`, commit subjects and `document` are transcript-derived text. Nothing in E3 touches `src/serve` or `src/remote`. Add one assertion to the D5.2 contract test: no remote tool's output schema contains `HandoffSnapshot` keys. E3 doesn't depend on the service-layer task. If that task has landed first, the new fields are computed inside `SessionsService.peek` rather than in `Engine.peek`. The shape is the same either way.

## Issue #5 — parent→subagent tree and write overlap in one view

**Issue.** "`peek list` is flat … an orchestrator can't see its own fan-out as a tree". The issue proposes `peek tree [session]` or `list --tree`, parent/child links, and coordination overlap folded in for each child.

**Reproduction** (`repro5.sh`). One Claude Code parent `parent-1`, plus two subagent sidecars `agent-aaa111` and `agent-bbb222`, each with a pending `Write` to `repo/src/shared.ts` and fresh timestamps.

```
peek list --json                       -> [claude-code:parent-1]                        (subagents hidden by default — intended)
peek list --include-subagents --json   -> parent-1, aaa111 (parent: "parent-1"), bbb222 (parent: "parent-1")
peek list --include-subagents (text)   -> flat rows "repo-claude-sub", "repo-claude-sub-2"; no parent shown
peek coord --json overlapHints         -> severity "high", src/shared.ts, sessionIds [bbb222, aaa111]   (overlap works)
check src/shared.ts --ignore-session claude-code:parent-1       -> conflictCount 2, exit 1
CLAUDE_SESSION_ID=parent-1 check src/shared.ts --ignore-self    -> conflictCount 2, exit 1
check src/shared.ts --ignore-session parent-1  (bare id)        -> conflictCount 0, exit 0
```

**Code.**

- Claude Code `scanSubagents` / `entryFor`, `src/adapters/claude-code/index.ts:83-142`. `parentSessionId: child.name` at line 104 is the bare directory name (the native uuid). The entry's own `id` is `claude-code:<agentId>` (line 134). The existing test pins the bare form (`test/adapters/claude-code-subagents.test.ts`, `expect(sub?.parentSessionId).toBe("parent-1")`).
- `resolveAuthor`, `src/feed/identity.ts:54-77`, returns `claude-code:${CLAUDE_SESSION_ID}` (line 57) or a prefixed `entry.id` (line 70).
- `check`, `cli/index.ts:190-225`, builds `ignoredSessions` from that prefixed id (lines 214-218).
- `isIgnoredSession`, `cli/index.ts:1260-1267`, compares `session.parentSessionId` (bare) against that set (prefixed). The comment at line 1247 says "A subagent's writes count as its parent's", but they never match.
- `list`, `cli/index.ts:104-175`, filters out subagents (lines 147-151, 163-166). It has no tree rendering, and `renderList` doesn't show the parent.
- `buildCoordinationSession`, `src/core/coordination.ts:53-96`, carries `parentSessionId` through (line 71). `buildOverlapHints`, lines 319-352, already reports child-vs-child overlap.
- Only the Claude Code adapter sets `parentSessionId` (`grep parentSessionId src`).

**Root cause.** Confirmed for both parts:

1. **No hierarchy view.** The data exists, but there's no tree view and the text list hides the link.
2. **Id-form mismatch (a bug the issue doesn't mention).** `parentSessionId` is a bare native id while every other session id is adapter-prefixed. So the parent-aware ignore in `check` never fires, and an orchestrator that runs `check --ignore-self` before editing gets exit 1 for its own children's writes.

One part is inferred and not reproduced: the issue's "isolated worktree worker". If Claude Code writes that worker as a sidecar under the parent, the link exists but its cwd is the worktree, so `coord <parent cwd>` filters it out through `cwdMatches` (`coordination.ts:311-317`). If it's written as a separate top-level transcript, no link exists at all. No real worktree-isolation transcript was available to check which applies.

**Proposed fix (E4).**

- **Id fix.** Add `parentId`, the adapter-prefixed form, to `SessionEntry` and `CoordinationSession`. Keep `parentSessionId` bare for compatibility (Q2). Make `isIgnoredSession` match the prefixed form. Every internal comparison uses `parentId`.
- **`peek tree [selector] [--all] [--json]`** (new command):
  - It runs the coordination digest with subagents included, and builds a forest from a pure `buildSessionTree(sessions, overlapHints, claims)` function.
  - Each node shows status, `currentTask`, `activeWritingFiles` and the claims it holds.
  - An overlap is flagged on each node it involves, and rolled up to the lowest common ancestor ("2 children writing src/shared.ts").
  - A selector roots the tree at that session. With no selector, the tree starts at the caller's self session (resolved through `resolveAuthor`), falling back to all roots.
  - Child cwd isn't filtered by the parent's cwd, which covers the worktree worker.
- **`list --tree`** as an alias that renders the same forest.
- **Stdio MCP: additive `session_tree` tool** that returns the `--json` shape. It must be added to the stdio set only. D5.2 doesn't list it for remote.

**Acceptance criteria.**

- 5a: on the §5 fixture, `check --ignore-self` (with `CLAUDE_SESSION_ID=parent-1`) and `--ignore-session claude-code:parent-1` both report zero conflicts and exit 0. `--ignore-session parent-1` still works.
- 5b: `peek tree --json` returns `parent-1` with two children, each showing `activeWritingFiles: [src/shared.ts]`, plus one `high` overlap attached to the parent.
- 5c: a subagent whose cwd is a different worktree is still listed under its parent.
- 5d: a subagent whose parent transcript has been deleted shows as an orphan root, not dropped (the adapter already discovers these).
- 5e: `list --json` and `list --include-subagents --json` keep every existing key and value.

**Tests.**

- A CLI integration test using the §5 fixture home, for 5a and 5b.
- A pure `buildSessionTree` unit test, for 5b–5d.
- A test in `claude-code-subagents.test.ts` asserting `parentId === "claude-code:parent-1"`.
- MCP golden additions. The `tools-list` projection already allows added tools (`test/golden/mcp.golden.test.ts:133`).

**Compatibility.**

- The CLI gains a new command and flag (additive).
- Stdio MCP gains a new tool (additive).
- The library type gains `parentId` (additive).
- No existing golden changes, because `test/golden/fixture-home.ts` creates no subagent sidecars. Add new golden cases.
- `check`'s exit code changes from 1 to 0 when a parent ignores itself. That's a bug fix toward the documented intent (line 1247), but it is a behaviour change on an exit code that integration tests assert (Q2).

**Spec overlap.**

- **D4 `SPAWNED` and `graph_subagents` / `peek graph subagents`** answer the historical question ("what did a session's subagents do?") from `graph.db`. `peek tree` answers the live question ("what are my children touching right now?") from the coordination digest. The two are complementary, not duplicates. Both need the same parent key: D2's `globalSessionId(entry)` gives `s:<machine>:<adapter>:<native>`, and building a `SPAWNED` edge from today's bare `parentSessionId` would need the adapter prefix reattached in the ingester. **Recommendation:** the E4 `parentId` fix lands before the D4 graph-ingest task, and the D4 `SPAWNED` builder reads `parentId`. Reuse the D4.3 three-level `SPAWNED` fixture for `buildSessionTree`.
- **D2.5 claims.** The tree shows claims held by each node. Before D2.5 that means the `ClaimsStore` JSON (absolute paths). After D2.5 it's the per-project SQLite claims with repo-relative paths. E4 shouldn't wait for D2.5. It reads claims through whichever store is current, and through `ClaimsService` if the service-layer task has landed.
- **Remote.** Pushed status (D5/D6) should carry the parent's global session id so a remote `coordination_digest` can nest children. That's a one-field addition to the D5 status payload. ADR 0002 already allows ids.

## Issue #6 — `task` captures a recent line, not the session goal

**Issue.** Two observed values were `task: I'll remove it from tracking, gitignore it …` and `task: Right — let me use peek's own capability instead of hand-authoring.` The actual goals were "land feature #1578 + doc follow-ups" and "docs-consolidation Phase 1/2". The issue proposes deriving `task` from the opening request or the dominant theme.

**Reproduction** (`repro.mjs` §6). The fixture user turns are "Land feature #1578 and the doc follow-ups." → "the .env.local got committed" → "yes".

```
structured.currentTask (latest user turn "yes")      -> "Right — let me use peek's own capability instead of hand-authoring."   <- issue example 2, verbatim
brief                                                 -> "Task: Right — let me use peek's own capability … Last assistant: …"
structured.currentTask (latest user turn is the ask)  -> "the .env.local got committed"                                        <- current ask, not the goal
```

**Code.**

- `toStructured`, `src/core/snapshot.ts:70-100`, tracks only the last human message (lines 77-80) and passes it to `inferCurrentTask` (line 86).
- `inferCurrentTask`, lines 159-169: if the last human turn is an acknowledgement (`isAcknowledgement`, 172-177), it walks backward through assistant messages and takes the first `objectiveFromAssistantText` match (196-204). "Right — let me …" qualifies.
- `toBrief`, lines 102-124, reuses `currentTask`.
- `toHandoff`, `handoff.ts:79`, copies it into the handoff and the "## Goal" heading of the local document (`renderLocalHandoff`).

**Root cause.** Confirmed.

1. The acknowledgement fallback prefers assistant narration over the previous human ask.
2. No field represents the session goal. `currentTask` was deliberately defined as the current ask (`d9c4ca7`, `517e025`). That's the right value for `list --files`, `coord` and `check` conflict output, which answer "what is it doing now".

**Proposed fix (E2).**

- **Fallback order.** When the latest human turn is an acknowledgement, walk back through human turns to the previous non-acknowledgement ask before looking at assistant text. With that, example 2 gives "the .env.local got committed". The assistant fallback remains only for sessions with no usable human ask.
- **Add `goal`** to `StructuredSnapshot`, `BriefSnapshot` and `HandoffSnapshot`. It's the first substantive human ask of the session, via `objectiveFromUserText` on human turns in order, skipping acknowledgements and harness wrappers. For a subagent that's its briefing's first line, which `objectiveFromUserText` already handles (lines 220-224).
- **Handoff document.** `## Goal` renders `goal`. `## Current state` adds "Current ask: <currentTask>" when it differs from the goal.
- **Not proposed:** redefining `currentTask` to mean the goal (Q1). That would change the task column in `list --files`, `coord` and `check` output for every multi-turn session.

**Acceptance criteria.**

- 6a: for the §6 fixture, `goal` is "Land feature #1578 and the doc follow-ups." in structured, brief and handoff output.
- 6b: with "yes" last, `currentTask` is "the .env.local got committed" and never an assistant line.
- 6c: a single-ask session has `goal === currentTask`.
- 6d: existing `snapshot.test.ts` task tests pass unchanged.

**Tests.** New cases in `test/unit/snapshot.test.ts` and `handoff.test.ts`.

**Compatibility.**

- Golden values are unchanged. Every fixture session has one substantive ask ("refactor auth", "run tests", "use the golden skill"), so `goal === currentTask` and the handoff `## Goal` line is identical.
- The `goal` key itself is additive, but it changes the bytes of `cli/at-structured.json`, `cli/at-by-tag-brief.json`, `cli/at-handoff-local.json`, `mcp/tool-peek-structured.json`, `mcp/tool-peek-brief.json`, `mcp/tool-peek-by-tag.json` and `mcp/tool-peek-handoff.json`. That's an explicit additive re-record (Q4).
- The fallback change alters `currentTask` values only in sessions whose last human turn is an acknowledgement. No golden fixture has one.

**Spec overlap.** None directly. D5 pushed status has a `summary≤2000` field. Using `goal` there would be authored or derived text that passes `assertExportable`'s length cap, but whether the goal (a user's prompt line) may leave the machine is an ADR 0002 question. Today's rule is that prompt text never leaves the machine. **Keep `goal` local-only.**

## Issue #7 — wrong paths and merely-mentioned files

**Issue.** Two problems:

- Paths like `<worktree>/src/apps/service.ts` where the real file is `apps/server/src/apps/service.ts`. "Looks like extraction is taking repo-relative shorthand … and joining it to the cwd."
- Files that were only read or grepped (for example `_template.md`) listed alongside edited ones.

**Reproduction** (`repro.mjs` §7). A temp workspace contains `apps/server/src/apps/service.ts`, `apps/server/src/mcp/tools.ts`, `docs/_template.md` and `src/real.ts`. The session:

1. `Read docs/_template.md`
2. `Bash: rg createApp src/real.ts`
3. `Bash: cd apps/server && sed -i … src/apps/service.ts`
4. Codex-shaped `exec_command { cmd: "sed -i … src/mcp/tools.ts", workdir: "<ws>/apps/server" }`

```
handoff touchedFiles:     ["<ws>/docs/_template.md", "<ws>/src/real.ts"]   <- the two files only read; both real edits missing
structured.writingFiles:  []                                               <- the session edited two files
# now add an unrelated <ws>/src/apps/service.ts (a same-named file at the root):
handoff touchedFiles:     ["<ws>/docs/_template.md", "<ws>/src/apps/service.ts", "<ws>/src/real.ts"]   <- wrong file
structured.writingFiles:  ["<ws>/src/apps/service.ts"]                                                 <- wrong file reported as WRITTEN
```

**Code.**

- `normalizePath`, `src/core/coordination.ts:715-720`, resolves every relative path against the session cwd. Nothing tracks a per-call working directory:
  - `extractCommandPaths` (690-704) and `writeTargetsOfCommand` (505-539) take the command string with its `cd apps/server &&` prefix, but no step applies that `cd`.
  - `collectPathValues` (636-650), `isPathKey` (652-655) and `commandInput` (667-672) never read Codex's `workdir` argument. The Codex parser passes the whole `arguments` object through as `input` (`src/adapters/codex/parse.ts:52-62`).
- `inferTouchedFiles` (354-371) drops a scraped path that doesn't exist (line 366, added in `1625fe3` on 2026-09-14, after the issue was filed). So on the release branch a mis-joined path is usually dropped rather than shown wrong, which hides the edit entirely. The original report's wrong-but-shown path is what `inferTouchedFiles` did before `1625fe3`. That's inferred from the commit message; the June transcript wasn't available.
- `inferWritingFileEvents` (377-407) keeps a write target if its parent directory exists, so a same-named decoy turns into a false write.
- `toHandoff`, `handoff.ts:83`, uses `inferTouchedFiles`, which deliberately mixes reads and writes. `test/unit/snapshot.test.ts:76-81` pins `Read` in `touchedFiles`, and `coord` uses that list for `recentFiles`. The handoff has no other list.
- A side gap, inferred and not verified against a current Codex transcript: `codex/parse.ts` handles only `function_call` (line 52). If a Codex version records freeform `apply_patch` as a different item type (for example `custom_tool_call`), those edits never reach any path extractor.

**Root cause.** Confirmed by reproduction.

1. The per-call working directory (`cd` prefix, `workdir`) is ignored. Real edits are lost, or misattributed to a same-named file, and the misattribution reaches `check`/`coord` as a write.
2. The handoff reuses a reads-plus-writes list with no role per file.

**Proposed fix (E1).**

- **`resolveCallCwd(tool, sessionCwd)`.** Use `workdir` or `cwd` from the tool input when it's absolute, or relative to the session cwd. For shell commands, split on `&&`, `;` and `||`, apply `cd <dir>` segments in order, and resolve each segment's paths against the cwd in effect at that point. `extractCommandPaths`, `writeTargetsOfCommand` and the named-argument path all go through it.
- **`classifyFileEvents(messages, cwd)`.** Returns `{ path, relPath, role: "wrote"|"read", state, movedTo? }`, ordered and folded per #1. `relPath` is relative to the git toplevel with POSIX separators. This should be the same helper D2.5 uses for claim paths (`toRepoRelative`).
- **Handoff output.** The handoff gets `files[]` (#4). The document's `## Files` section lists `role: "wrote"` files, plus a one-line "Also read: …" list. `touchedFiles` keeps its meaning.
- **Fix for `writingFiles`.** It uses the corrected resolution, so `coord`/`check` stop reporting the decoy.
- **Codex.** Add a parser case for the freeform patch item type if one exists, verified against a real current Codex rollout first.

**Acceptance criteria.**

- 7a: on the §7 fixture, `files` lists `apps/server/src/apps/service.ts` and `apps/server/src/mcp/tools.ts` as `wrote`, and `docs/_template.md` and `src/real.ts` as `read`.
- 7b: with the decoy present, the decoy is not in `writingFiles` or in `files` as `wrote`.
- 7c: `check apps/server/src/apps/service.ts` sees the session as writing it, and `check src/apps/service.ts` doesn't.
- 7d: every existing `snapshot.test.ts`, `coordination` and golden test passes unchanged.
- 7e: `relPath` is identical for the same file from two clones at different absolute paths (the D2.1/D4.5 pattern).

**Tests.** `test/unit/coordination-paths.test.ts` (the `cd` chain, `workdir`, decoy, nested `cd ..`), the §7 fixture in `handoff.test.ts`, and a `check` CLI integration case with the decoy.

**Compatibility.**

- `files` is additive (golden re-record, Q4).
- `writingFiles`, `touchedFiles` and `check` conflicts change values in sessions that used `cd` or `workdir`. That corrects wrong output, but it's a behaviour change on `check`'s exit code.
- No golden value moves: every fixture file list is `[]`, and the Codex fixture's `cat auth.ts` has no `workdir` or `cd`.

**Spec overlap. This is the most load-bearing ordering in this document.**

- **D2.5 (repo-relative claim paths).** It needs the same `toRepoRelative` helper. Whichever PR lands first owns it, and the other imports it.
- **D6.4 (`peek agent` sidecar).** It publishes "inferred-write claims" derived "the same … as local coordination", which means `writingFiles`. Without E1, a sidecar in a cloud VM would publish claims on wrong files (the decoy case) and miss real edits, and those claims block other agents through `409`/`check`.
- **D4.** It builds heuristic `READ`/`WROTE` edges from "the existing `inferTouchedFiles` family". Wrong paths would become deterministic `f:<project>:<path>` nodes that persist (`last_seen = max()`).
- **Recommendation:** E1 is its own PR on `release/0.7.0` and should land **before** the D4 graph-ingest task and the D6 sidecar task. It has no dependency on the service-layer task.

## Grouping proposal

Four PRs onto `release/0.7.0`, each with its own tests:

| PR | Issues | Scope | Depends on | Must land before |
|---|---|---|---|---|
| **E1** — path resolution and file roles | #7, #1 (files) | `resolveCallCwd`, `classifyFileEvents`, `toRepoRelative`, end-state fold, corrected `writingFiles` | nothing | D4 graph ingest (`READ`/`WROTE`), D6 sidecar (inferred-write claims). Share `toRepoRelative` with D2.5. |
| **E2** — handoff signal quality | #2, #1 (questions), #6 | `handoff-signal.ts` rules, the answered-question rule, the acknowledgement fallback fix, the `goal` field | nothing | E3 (so the schema freezes once) |
| **E3** — handoff JSON v1 and git artifacts | #4, #3 | `schemaVersion`, `files`, `git`, `goal` on the snapshot, `handoff.v1.json`, `git-artifacts.ts`, `## Git` section | E1 (`files`), E2 (`goal`) | D4 graph ingest (`COMMITTED` reuses `git-artifacts.ts`) |
| **E4** — session tree and parent id | #5 | `parentId`, the `isIgnoredSession` fix, `buildSessionTree`, `peek tree`, `list --tree`, stdio `session_tree` | nothing. Uses `ClaimsService`/`CoordinationService` if the service-layer task has landed. | D4 graph ingest (`SPAWNED` reads `parentId`), D5/D6 status payload parent field |

E1, E2 and E4 can run in parallel. E3 goes last among the handoff PRs.

None of the seven issues is covered by an existing spec deliverable. The spec should gain a **D9 addendum, "Handoff and multi-agent accuracy"**, holding the acceptance criteria above (1a–7e). It should also add three dependency notes to existing tasks: D4 ingest reads `parentId` and `git-artifacts.ts`, D6.4 depends on E1, and D2.5 shares `toRepoRelative`.

Under the spec's process, each E-PR gets review notes written against D9, and every criterion in it gets QA evidence. These are all CLI/library changes with no rendered UI, so a visual-evidence exception applies. They should be verified with terminal transcripts and test output, not screenshots.

## Questions for the owner

1. **#6: what `task` means.** The issue asks for `task` to be the session goal. I recommend keeping `currentTask` as the current ask, because `list --files`, `coord` and `check` show it as "what is it doing now", and adding a new `goal` field that the handoff's "## Goal" uses. Is that acceptable, or should `currentTask` itself change meaning? Changing it alters a value in CLI, MCP and library output for every multi-turn session.
2. **#5: parent id form and the `check` exit code.**
   - Keep `parentSessionId` bare and add a prefixed `parentId` (my recommendation), or change `parentSessionId` to the prefixed form, which changes a value in `list --include-subagents --json`, `coord --json` and the library type?
   - Do you accept that `check --ignore-self` from a parent stops reporting its own subagents' writes (exit 1 → 0)? The code comment says that was always the intent.
3. **#4: key names and the runner.**
   - Keep existing keys and add new ones (`files`, `git`, `goal`, `schemaVersion`), or adopt the issue's names (`session`, `task`, object-valued `files`)? The issue's names break the additive rule.
   - Should `--mode handoff --json` keep spawning the agent CLI by default (today's behaviour), or imply `--local`? Only `document` differs between the two.
4. **Golden policy for additive keys.** E2, E3 and E4 add keys to existing golden snapshots (listed per issue). Will you accept a rule that a golden may be re-recorded when projecting the old snapshot onto the new output is byte-identical, with that projection asserted in the suite like the existing `tools-list` check? The alternative is to put every new field behind a new flag, so that no existing golden changes at all.
5. **#3: subprocesses and network.** Building a handoff would newly run read-only `git rev-parse` and `git status --porcelain` in the session cwd. Should it also call `gh` to refresh PR state over the network? I recommend no: report PR state as recorded in the transcript.
6. **#2: trailing offers.** Is an unanswered closing offer such as "Would you like me to also commit it?" an open question, or chrome to drop? Stock closers like "Anything else?" are dropped either way.

## Evidence gaps

- **Worktree-isolated worker (#5).** The parent/child linkage for Claude Code's worktree-isolated workers is inferred. No real transcript was available.
- **Codex freeform patches (#7).** Whether current Codex records freeform `apply_patch` outside `function_call` was not checked against a real rollout.
- **Original wrong path (#7).** Its cause is inferred from the commit history (`1625fe3`). The June transcript wasn't available.
- **Schema validator (#4).** Whether a JSON Schema validator is already in devDependencies was not checked.
- **Real transcripts.** All reproductions use hand-built fixtures, not real Claude Code or Codex transcripts from the sessions the issues describe.
