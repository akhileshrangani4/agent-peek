# Research D — OpenCode retry monitor

Read-only research for the 0.7 spec addendum on `peek monitor`, done 2026-11-13. No agent-peek code was changed and no PR was opened.

**What I read**

- lachieh's PR #12 and his fork's branches, through `gh`.
- The OpenCode source at tag **v2.3.0** (commit `a6b15d3`, 2026-11-13). `sst/opencode` now redirects to `anomalyco/opencode`, so the citations below point at <https://github.com/anomalyco/opencode/tree/v2.3.0>.
- agent-peek `release/0.7.0`, the spec [spec-0.7.md](spec-0.7.md) and Research A [research-a-codebase-map.md](research-a-codebase-map.md).

I did not read OpenCode's website docs. Every OpenCode fact here comes from source code at that tag. None of it was run against a live OpenCode install.

## Summary

The monitor can be built safely, and OpenCode already supplies most of what it needs:

- **Failure detection is structured.** Every failed turn writes a durable `idle` message whose `outcome` is `failed` and whose `error.type` names the cause, such as `provider.rate-limit` or `tool.execution`. The monitor never needs to read prose.
- **Resubmission can be idempotent.** The `opencode serve` HTTP API accepts a message `id` chosen by the client. Sending the same id again returns the first admission rather than creating a second message. If the monitor generates and saves that id before it submits, a crash or a racing monitor cannot double-submit.

The CLI path (`opencode run --session`) is unsafe for automated retries:

- It mints a fresh id on every call.
- It auto-replies to permission prompts and cancels open forms.
- A signal interrupts the session.

**Recommendation: Option A.** Run a local monitor in agent-peek that:

- reads `opencode.db` read-only;
- keeps a fingerprint table in `~/.agent-peek/monitor.db`;
- resubmits through `POST /api/session/{id}/synthetic` on the already-registered OpenCode background service, using the saved message id.

**Defaults.** Only transient provider errors qualify, with at most 3 attempts per failed turn and backoff of at least 5 minutes. OpenCode has already retried each call up to 10 times before it records the turn as failed.

**Scope.** The monitor stays local. It is not part of `peek serve` or the remote MCP set.

**One blocker.** agent-peek has no OpenCode V2 adapter on `release/0.7.0` yet, and the monitor depends on one.

> **Load-bearing assumption:** this design assumes a single "continue" input sent after a `failed` idle makes OpenCode re-run the turn usefully, which helps the user.
>
> - **Evidence it rests on.** OpenCode's own crash recovery does exactly this. It sends a synthetic "Continue from where you left off" message (`restart.ts:24-25`, `:106-111`). That is code, not a measured outcome.
> - **What breaks it.** It fails if failed turns are mostly persistent: quota, auth, a model that keeps rejecting the request. In that case retries add cost and noise.
> - **Check before committing.** Run a QA probe that forces a `provider.rate-limit` or `provider.internal` failure on a real v2.3.0 session, sends one synthetic continue, and records whether the next idle is `succeeded`.
> - **What the brief skipped.** OpenCode already retries transient errors in-process: 10 retries with exponential backoff, and up to an hour for network-unreachable errors. A turn that still fails may be failing for a reason another attempt won't fix. A notify-only monitor (Option C) could deliver most of the value: a human sees the stuck session and decides.

## 1. lachieh's intent (PR #12 and fork)

**PR #12** (<https://github.com/akhileshrangani4/agent-peek/pull/12>) has the title "feat: add OpenCode V2 observation and retry monitoring". It is open against `main`, from `lachieh:feat/opencode-v2-retry-monitor`, with 2 commits.

The body's plan has two items checked and four unchecked:

- [x] rename the filesystem adapter to `opencode-legacy-v1`
- [x] support V2 `opencode.db`
- [ ] expose execution outcome for monitoring
- [ ] add retry policy and durable state
- [ ] add an OpenCode retry transport
- [ ] add monitor CLI commands and tests

Its Safety section reads verbatim: "The monitor will be opt-in, never retry child sessions, never infer provider failure from transcript prose, and persist a failure fingerprint before submission." Its Progress section says V2 observation was "smoke-tested read-only against the local `opencode.db`".

**Fork branch `feat/session-monitor`** is 3 commits ahead of lachieh's `main` and 0 behind (`gh api repos/lachieh/agent-peek/compare/main...feat/session-monitor`). Its commits are:

1. "refactor(opencode): preserve v1 adapter under legacy name"
2. "feat(opencode): add V2 sqlite adapter"
3. "fix(monitor): harden session health polling"

It adds `src/monitor/{index,monitor,store,types}.ts`, a `peek monitor <add|list|remove|run|watch>` command and tests. This is a **read-only health monitor**, not a retry monitor:

- **Health states.** `MonitorHealth` takes the values `unknown | running | idle | stale | tool-error | failed | succeeded | interrupted` (`src/monitor/types.ts`).
- **State storage.** State is kept in `~/.agent-peek/monitor.json` under `proper-lockfile`, written to a temp file and then renamed (`src/monitor/store.ts:4`, `:24`, `:137-152`).
- **Classification.** Health comes from `execution.outcome` plus a stale threshold (`src/monitor/monitor.ts:99-112`).
- **Outcome on the session entry.** The fork's adapter adds `SessionEntry.execution { state, outcome, at, sequence, detail }` (`src/core/types.ts:6-15`). It reads `outcome` from the latest `idle` message's `data.outcome` and maps `parent_id` to `parentSessionId` (`src/adapters/opencode/index.ts:59-72`, `:129`). It locates the DB as `$XDG_DATA_HOME/opencode/opencode.db` (`:145-148`).

On the fork, no retry transport, retry policy or fingerprint exists. The last three plan items are still unbuilt.

**Reusable prior art:** the CLI shape (`add/list/remove/run/watch`), the `execution` field on `SessionEntry`, and health classification from structured outcome. **Not reusable:** a JSON store under a file lock cannot give the atomic "insert fingerprint or lose the race" step a retry needs (see §4).

## 2. OpenCode V2 facts (v2.3.0)

### 2.1 How a failed top-level session is recorded

| Fact | Source |
|---|---|
| `session_v2` has `parent_id` (null for top-level sessions; indexed by `session_v2_parent_idx`), plus `time_busy`, `time_idle`, `idle_outcome` and `resume_attempts` (not null, default 0). | `packages/core/src/session/sql.ts:37`, `:66-69`, `:74`, `:79` |
| `session_message` rows are `(id, session_id, type, seq, time_created, …, data JSON)`, with a unique index on `(session_id, seq)` and an index on `(session_id, type, seq)`. | `sql.ts:87-102` |
| The idle message schema is `type: "idle"`, `outcome: "succeeded" \| "failed" \| "interrupted"`, `error?: SessionError.Error`. Its doc comment says it "marks the Session going idle… A shutdown does not record one, since the resumed execution continues the same turn." | `packages/schema/src/session-message.ts:293-304` |
| `session.execution.succeeded` produces `idle("succeeded")`. `session.execution.failed` produces `idle("failed", event.data.error)`. `interrupted` produces `idle("interrupted")`, except when the reason is `shutdown`, which records nothing. | `packages/core/src/session/message-updater.ts:148-153` |
| An idle message's id comes from the durable event id (`SessionMessage.ID.fromEvent(event.id)`, which rewrites `evt_` to `msg_`), so each failed turn has a stable, unique id. | `message-updater.ts:75`, `:101`, `:115`; `session-message.ts:26` |
| The error shape is `{ type: string, message: string, status?: 100–599, response?: { body: string }, retryAfterMs?: int ≥ 0 }`. `retryAfterMs` is "counted from when the failure was recorded". | `packages/schema/src/session-error.ts:7-14` |
| The `type` taxonomy splits into four families. **Provider:** `provider.rate-limit`, `.auth`, `.quota`, `.free-limit`, `.chatgpt-limit`, `.content-filter`, `.transport`, `.internal`, `.invalid-output`, `.invalid-request`, `.unsupported-operation`, `.unknown`, `.timeout`, `.no-route`, `.budget-limit`, `.model-budget-limit`, `.go-limit`. **Tool:** `tool.execution`. **User or policy:** `permission.rejected`. **Other:** `unknown`. | `packages/core/src/session/to-session-error.ts:40-122` |
| A turn that OpenCode's own restart recovery interrupted too many times becomes `failed` with `{ type: "aborted" }`. | `packages/core/src/session/execution/restart.ts:27-30`, `:98-104` |
| The DB is in WAL mode with `busy_timeout = 5000`. | `packages/core/src/database/database.ts:42-44` |
| The DB file is `opencode.db`, except that `OPENCODE_DB` overrides it and non-default channels use `opencode-<channel>.db`. | `packages/cli/src/database-path.ts:4-12` |

So the monitor's detection query is: the latest `idle` message of a session with `parent_id IS NULL`, where `data.outcome = 'failed'`, classified by `data.error.type`. A provider failure is any `provider.*` type. A tool failure is `tool.execution`. A user or policy stop is `permission.rejected`, or the `interrupted` outcome. Prose is never read.

Two cautions:

- `error.message` and `error.response.body` can carry provider text, which may echo the prompt. The monitor must not store or export them (§4, §5).
- lachieh's adapter hard-codes `opencode.db` and ignores `OPENCODE_DB` and channel names. The 0.7 adapter should honour both, in the same way D3 honours `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.

### 2.2 OpenCode's own retries (why the monitor's budget must be small and slow)

- **Model calls.** Each call is retried in-process: exponential from 2 s, capped at 10 s per gap, for 10 retries. That is about 84 s of waiting, and the delay honours provider `retry-after` up to 15 min (`packages/core/src/model-retry.ts:11-35`).
- **Unreachable network.** Errors such as `ENOTFOUND` or `ENETUNREACH` have their own budget, up to 1 hour (`:37-55`).
- **Timeouts.** Timed-out attempts are capped at 3 (`:57`).
- **Retryable flag.** `isRetryable` is the error's own `isRetryable` flag (`packages/ai/src/provider-error.ts:87`).
- **Restart recovery.** Crash and restart recovery resumes an orphaned turn up to 10 times before it terminalizes it as `aborted` (`restart.ts:32-41`, `:91-111`).

A `failed` idle therefore means OpenCode's in-process retries were exhausted or the error was not retryable. A monitor retry is a second, coarser layer on top.

### 2.3 Interfaces that can continue an existing session

| Interface | Exact form | Auth | Verdict for the monitor |
|---|---|---|---|
| **HTTP: synthetic input** | `POST {server}/api/session/{sessionID}/synthetic`, with body `{ id?: "msg_…", text, description?, metadata?, delivery?: "steer"\|"queue", resume?: boolean }` (`text` required). Responses: 200 `{data: Inbox item}`, plus 400/401/404/409. "Durably admit synthetic session input and schedule execution unless resume is false." | HTTP Basic, username `opencode`, password from the service registration (see below) | **Recommended.** This is the same mechanism OpenCode uses to continue after a restart. |
| **HTTP: user prompt** | `POST {server}/api/session/{sessionID}/prompt`, with body `{ id?, text, files?, agents?, skills?, metadata?, delivery?, resume? }`. Same responses. | Same | Works, but the retry then looks like something the user typed. |
| HTTP: helpers | `GET /api/session/{id}` (session info, including outcome), `GET /api/session/active` ("foreground Session drains currently owned by this OpenCode process"), `GET /api/session/{id}/inbox`, `GET /api/info` (health: `{version, pid}`) | Same | Pre-submit checks |
| SDK | `@opencode/sdk` 2.3.0 / `@opencode/client` 2.3.0: `client.session.prompt({ sessionID, id, text, delivery })`. The CLI itself uses this, via `OpenCode.make({ baseUrl, headers })`. | `headers: { authorization: "Basic …" }` | It's the same HTTP call. Using it would add a dependency that agent-peek doesn't otherwise need. |
| CLI | `opencode run --session <id> "<message>"` (alias `-s`; "Session ID to continue, or to create if it does not exist"), `opencode run --continue` (alias `-c`, last session), with `--fork`, `--server <url>` and `--standalone` | Through `--server` plus `OPENCODE_PASSWORD` (legacy `OPENCODE_SERVER_PASSWORD`) | **Unsafe for automation**; reasons below |

**Sources:**

- OpenAPI: `packages/protocol/openapi.json:2036` (prompt), `:2402` (synthetic), `:1427` (active), `:3282` (inbox). The spec's `info.description` reads "Experimental HttpApi surface for selected instance routes."
- `Session.Inbox.Delivery` is `"steer" | "queue"`.
- Server handler: `packages/server/src/handlers/session.ts:290-316`.
- CLI flags: `packages/cli/src/commands/commands.ts:14-28`, `:396-440`.
- `opencode serve [--hostname] [--port] [--cors] [--service] [--stdio]`: `commands.ts:579-592`.
- Env: `packages/cli/src/env.ts:10-13`.

**How a client finds the server.** The background service registers in `$XDG_STATE_HOME/opencode/service.json`, defaulting to `~/.local/state/opencode/service.json` (`packages/client/src/service-probe.ts:38-40`). The registration holds `url`, `pid`, `version` and an optional `password`. A client probes `GET /api/info` and checks that `pid` and `version` match (`:47-90`). It authenticates as `Basic opencode:<password>` (`:49-50`, `:93-98`).

`--standalone` runs "a private server instead of the background service". That server does not register, so the monitor cannot reach it.

**Why the CLI is unsafe as a retry transport:**

- **Fresh id every time.** It mints a new message id on every invocation (`packages/cli/src/run/noninteractive.ts:71`), so a re-run after a crash double-submits.
- **Wrong delivery mode.** It submits with `delivery: "steer"` (`:217-223`), which injects into a turn already running.
- **Acts for the user.** After admission it replies to every pending permission and cancels open forms (`:224-236`). An unattended monitor must not do either.
- **Signals interrupt the session.** On SIGINT or SIGTERM it interrupts the session and its child jobs (`run.ts:53-56`; `noninteractive.ts:166`, `:266`). Killing a hung child process therefore aborts the retried turn.
- **Blocks for the whole turn.** It runs until the turn finishes, so one monitor tick could take as long as an agent turn.

**Versions.** Everything above was verified only at v2.3.0. I did not establish the earliest version with `/synthetic` and a client-supplied `id`. The monitor should read `GET /api/info` and refuse to submit to a server older than a pinned minimum, initially `2.3.0`. Because OpenCode labels the HTTP API experimental, pinning is necessary.

### 2.4 Is a retry idempotent?

**Yes, if the client supplies the id.** Admission is "first admission wins for matching Session and type" (`packages/core/src/session/inbox.ts:176-189`):

- Before preparing anything, `Session.prompt` and `Session.synthetic` call `admission.reconcile` / `admission.admit` with the message id (`packages/core/src/session/session.ts:155-190`, `:296-325`).
- If a record with that id exists for the **same session and same type**, the stored item is returned. `matches()` compares only `sessionID` and `type`, not text or delivery (`inbox.ts:79-84`).
- An id already used by another session, or by a different type, is a `LifecycleConflict`. The server maps that to **HTTP 409** "Prompt message ID conflicts with an existing durable record" (`server/src/handlers/session.ts:307-314`).
- Ids are only checked for the prefix `msg_` (`session-message.ts:21`). OpenCode generates them as a time-ordered hex prefix plus random characters (`packages/schema/src/identifier.ts:16-33`). The monitor should generate ids the same way rather than invent a format, because ordering by id is used as a tie-breaker in `session_message_session_time_created_id_idx` (`sql.ts:102`). That a non-time-ordered id breaks anything is *inferred*, not shown.

**Caveat.** A replayed admission still calls `execution.wake` unless `resume: false` (`session.ts:187`; synthetic `:321`). OpenCode's execution layer keeps a write-ahead claim and serializes drains per session (`packages/core/src/session/execution.ts:75-83`), so a second wake does not start a second concurrent turn. *Inference:* a wake on a session with nothing pending is a no-op. I did not trace the drain loop far enough to prove it.

**Double-submission between actors:**

| Race | Protection |
|---|---|
| Two `peek monitor` processes on one machine | A unique fingerprint row inserted under `BEGIN IMMEDIATE` in `monitor.db`. The loser sees the row and does nothing. If the winner crashes after inserting but before the POST, the next tick re-sends the **same saved id**, and OpenCode returns the original admission. |
| Monitor and a human (TUI, `opencode run`) | Just before the POST, the monitor re-reads `opencode.db` and skips unless all of the following hold: (a) the session's latest `idle` is still the fingerprinted one; (b) no `session_message` exists with a higher `seq`; (c) `time_busy ≤ time_idle`; (d) the session is absent from `GET /api/session/active`, and `GET /api/session/{id}/inbox` is empty. |
| Residual window | Between check (d) and the POST, a human prompt can still land. Both inputs would then be admitted. With `delivery: "queue"`, the retry waits behind the human's turn instead of steering into it. That is benign, but it costs one extra turn. Closing the window completely would need a compare-and-set admission API, which OpenCode does not have. |
| Monitors on two machines | Not a real case. `opencode.db` and the background service are per-machine, and the monitor is local-only. |

## 3. Constraints from PR #12, and policy options

The four safety rules hold in every option below:

- **Opt-in.** No monitor runs unless the user starts it. Retrying additionally needs an explicit `--retry` flag, or enrollment of the session or project.
- **Never child sessions.** The detection query requires `session_v2.parent_id IS NULL`. The check is repeated against `GET /api/session/{id}` before submit.
- **Never infer failure from transcript prose.** Only `data.outcome` and `data.error.type`, `status` and `retryAfterMs` are read.
- **Fingerprint before submit.** The fingerprint row is committed before any network call.

### Which outcomes qualify

| Default | Types |
|---|---|
| **Retry** (transient) | `provider.rate-limit`, `provider.internal`, `provider.transport`, `provider.timeout` |
| **Opt-in only** (`--include`) | `provider.unknown`, `provider.invalid-output`, `provider.no-route`, `aborted` |
| **Never** (persistent, or a person's decision) | `provider.auth`, `.quota`, `.free-limit`, `.chatgpt-limit`, `.budget-limit`, `.model-budget-limit`, `.go-limit`, `.content-filter`, `.invalid-request`, `.unsupported-operation`, `tool.execution`, `permission.rejected`, `unknown`; and outcomes `interrupted` and `succeeded` |

`aborted` means OpenCode's own resume budget of 10 is exhausted, so a further automatic retry is a crash-loop risk. That is why it is opt-in only. An unrecognised future `provider.*` type is treated as **never** (fail closed).

### Attempts and backoff: options

| Option | Rule | Cost | Fails when |
|---|---|---|---|
| **P1, fixed budget per failed turn (recommended)** | Max 3 attempts per failed turn (a "turn" is the chain of failures after the last `succeeded` idle). Delay = max(`retryAfterMs` from the failure time, 5 min × 2^(n−1)), capped at 60 min. The counter resets on a `succeeded` idle. | Simple, and bounded at 3 extra turns. | A provider outage longer than about 35 min exhausts the budget, and the session waits for a human. |
| P2, time window | Retry until 6 h after the first failure, at the same backoff | Rides out long outages | Up to about 8 extra turns. Cost is less predictable. |
| P3, single shot | 1 attempt, after max(`retryAfterMs`, 10 min) | Smallest blast radius | Recovers less often |

A global cap is useful under any option. For example, at most 1 retry in flight per machine and 10 per hour, so a provider outage across many sessions doesn't produce a burst.

## 4. Durable state

**Location.** `~/.agent-peek/monitor.db`, opened with `node:sqlite` in WAL mode with a busy timeout, and migrated through `PRAGMA user_version`. This follows `usage.db` and the 0.7 per-store module rule.

It is machine-scoped, not per project: it describes local OpenCode sessions on this machine. A table inside the per-project feed store would tie the monitor to project identity, which a local session doesn't need. It would also put the table on a store that `peek push` reads.

```sql
-- v1
CREATE TABLE enrollment (            -- opt-in scope
  scope TEXT NOT NULL,               -- 'session' | 'project' | 'all'
  key TEXT NOT NULL,                 -- 'opencode:ses_…' | projectId | '*'
  created_at TEXT NOT NULL,
  policy TEXT NOT NULL,              -- JSON: {maxAttempts, include[], ...}
  PRIMARY KEY (scope, key));

CREATE TABLE retry (                 -- one row per failed turn the monitor acted on
  fingerprint TEXT PRIMARY KEY,      -- sha256(dbIdentity | sessionId | failedIdleMsgId)
  db_identity TEXT NOT NULL,         -- hash of resolved opencode.db path + channel
  session_id TEXT NOT NULL,          -- native ses_… id
  failed_idle_id TEXT NOT NULL,      -- msg_… from the idle row (event-derived, stable)
  failed_idle_seq INTEGER NOT NULL,
  error_type TEXT NOT NULL,          -- e.g. provider.rate-limit
  error_status INTEGER,              -- HTTP status if present
  retry_after_ms INTEGER,
  failed_at TEXT NOT NULL,
  chain_id TEXT NOT NULL,            -- groups failures since the last succeeded idle
  attempt INTEGER NOT NULL,          -- 1-based within chain
  state TEXT NOT NULL CHECK (state IN
    ('planned','submitted','admitted','skipped','abandoned','conflict')),
  skip_reason TEXT,                  -- enum: busy, human-acted, child, policy, version, no-server
  retry_message_id TEXT NOT NULL UNIQUE,  -- msg_… generated BEFORE submit, reused on resend
  not_before TEXT NOT NULL,
  submitted_at TEXT, admitted_at TEXT,
  http_status INTEGER,
  lease_owner TEXT, lease_until TEXT);    -- pid@boot for crash takeover
CREATE INDEX retry_session ON retry(session_id, attempt);
```

**Never stored:** `error.message`, `error.response.body`, prompt or transcript text, or the server password. Read the password fresh from `service.json` on each call.

The retry text is a fixed constant, for example "The previous attempt failed with a transient provider error. Continue from where you left off without repeating completed work." It carries `metadata: { source: "agent-peek.monitor", fingerprint }`, which makes the retry visible and attributable inside OpenCode.

**State machine:**

- **Detect.** The fingerprint is inserted as `planned`, with a new `retry_message_id` and a `not_before` time, all in one transaction.
- **Due.** The monitor takes the lease and runs the pre-submit checks from §2.4. If they fail, the row becomes `skipped` with a reason. If they pass, it POSTs and records `submitted`, then `admitted` on 200.
- **409.** The row becomes `conflict`. It is never retried with a different id.
- **Lease expiry.** Another tick resends the same id.

## 5. Fit with 0.7

- **Service layer.** Add `src/app/monitor-service.ts` (`MonitorService`, which takes a `Clock`, a `MonitorStore`, an `OpenCodeExecutionReader` and an `OpenCodeRetryTransport`). Add `src/monitor/store.ts` for `monitor.db`, `src/monitor/policy.ts` as pure functions (`classify(error)`, `nextAttempt(chain, now)`), and `src/monitor/opencode-transport.ts`, which wraps HTTP and service discovery. The CLI `peek monitor …` stays a thin adapter, following the D3 rule.
  - The retry transport does **not** go on the `Adapter` interface. The spec keeps the `./adapter` plugin ABI unchanged and read-only ([spec-0.7.md](spec-0.7.md) §D3, D7).
  - Outcome reading belongs in the OpenCode V2 adapter, as `SessionEntry.execution`. That is additive to `SessionEntry`, so it needs a compatibility note but no ABI break.
- **MCP.** Nothing in the remote registry. For stdio, at most a read-only `monitor_status` tool. I recommend none in 0.7, so that agents cannot start retries themselves.
- **Feed.** The feed is optional and derived-only. On `abandoned` (budget exhausted) and on a `never`-class failure in an enrolled session, post one derived `warning` post. Its title is structural: "OpenCode session ses_… failed: provider.quota (retries exhausted 3/3)". It carries `evidence: [{kind: "session", ref}]` and no error message or body. `submitted` and `admitted` attempts go to the monitor's own log, not the feed, to keep noise down.
  - Under ADR 0002 a derived post is exportable (`docs/adr/0002-graph-and-network-retention.md:41`). Error type and session id are structure, so `assertExportable` (`src/export/assert-exportable.ts`) permits pushing such a post when a remote is configured.
  - Whether a local OpenCode failure should reach a shared feed at all is an owner decision. The default should be off unless the feed is local-only.
- **Local-only.** Yes. `monitor.db` is never pushed and has no remote route. The transport only talks to the loopback OpenCode service URL found in `service.json`.
- **`peek serve` and cloud agents.** Out of scope. Cloud agents don't run OpenCode V2 here. A server-side retry runner is already a spec non-goal ("a server-side handoff runner"), and acting on another machine's session would need a remote control channel that ADR 0002's trust model does not cover.

## 6. Design options

| | **A. HTTP synthetic, client-supplied id (recommended)** | B. Spawn `opencode run --session` | C. Detect and notify only |
|---|---|---|---|
| How | Read `opencode.db` read-only, save fingerprint and id, `POST /synthetic` to the registered service with `delivery: "queue"` | Same detection, then spawn `opencode run -s <id> "<text>" --server <url>` | Same detection and fingerprint. Post a feed warning or desktop notice, and print the `opencode run -s` command for the human |
| Idempotent | Yes (`inbox.ts:176-189`) | **No.** A fresh id on every run (`noninteractive.ts:71`) | n/a (no submit) |
| Side effects beyond the retry | None | Auto-replies permissions, cancels forms, interrupts on signal | None |
| Needs a running OpenCode service | Yes. Skips with `no-server` otherwise, and never starts one. | Will start the background service if none is running (*inferred* from `--server`/service flags) | No |
| Dependencies | `fetch` only | `opencode` binary on PATH | None |
| Risk | Experimental HTTP API, mitigated by a version pin and contract test | Double submits; unattended permission grants | Doesn't satisfy "retry"; a human must act |
| Cost to build | Medium | Low | Low |

**Recommendation: A, shipped with C's notice path, and retry gated behind `--retry`.**

- **What improves:** retries are idempotent and attributable, and the monitor never acts on the user's behalf beyond one queued continue.
- **What it costs:** it depends on an HTTP surface OpenCode calls experimental, and it needs the background service running.
- **What would reverse the call:** if the QA probe in the load-bearing assumption above shows a synthetic continue after `failed` rarely leads to `succeeded`, ship C alone in 0.7.

## 7. Unknowns

### Block the spec (resolve before the D8 addendum is approved)

1. **The dependency on the OpenCode V2 adapter.** `release/0.7.0` has only the legacy filesystem adapter (`src/adapters/opencode/index.ts`). PR #12 targets `main`, and follow-up task to land the V2 adapter (it later merged as PR #17) is open. The addendum must say whether D8 depends on V2 landing first, or takes the V2 adapter into scope. **Resolver:** the owner.
2. **Whether retries are wanted, given the load-bearing assumption.** Ship A (`--retry`) or only C in 0.7. This depends on the owner's tolerance for automated extra turns and cost. **Resolver:** the owner. The QA probe above is the evidence.
3. **Feed policy.** Should monitor `warning` posts be written at all, and may they be pushed when a remote is configured? **Resolver:** the owner. I recommend writing them locally and allowing the push, since the content is structural.

### Affect only implementation or QA

- The earliest OpenCode version with `/synthetic` and a client `id`. Pin `≥ 2.3.0` and verify through `GET /api/info`.
- Runtime confirmation that a failed turn writes the `idle` row exactly as the code says. A fixture must come from a real v2.3.0 `opencode.db` with a forced failure.
- Whether a replayed admission's extra `wake` is always a no-op (§2.4, inferred).
- Whether a non-time-ordered `msg_` id causes problems (avoided by generating ids OpenCode's way).
- The `service.json` field names, read from the `Info` type in `packages/client/src/service.ts`, which I did not open.
- Behaviour when the session was last driven by a `--standalone` or `--server` process. The DB is shared and the execution claim serializes drains, but this was not traced.
- The exact text of the retry message and its `description` label.
- The OpenCode website docs, which I did not consult. Every fact above is from source at v2.3.0.
