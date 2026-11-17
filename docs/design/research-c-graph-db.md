# Research C — graph DB & conversation knowledge graph options

*Read-only research on `akhileshrangani4/agent-peek` (`main`), 13 Nov 2026. No code, branch or PR. Code references are `path:line` in that checkout. Every web source was retrieved on 13 Nov 2026 and is listed in Sources, marked as a page fetch or a search snippet. Anything from training data says so.*

**Recommendation.** Don't adopt a dedicated graph database yet. Store the knowledge graph as typed `node` and `edge` tables. Locally they live in `node:sqlite` beside the existing feed and usage stores, queried with B-tree indexes, FTS5 and recursive CTEs. When hosted, the same schema runs first on single-node SQLite inside the self-hostable `peek serve` that Research B recommends ([research-b-cloud-architecture.md](research-b-cloud-architecture.md)). It moves to Postgres with pgvector only when hosted multi-tenancy arrives. One narrow typed query API fronts every tier. The data is graph-shaped, but each query the brief names needs one or two hops plus a filter and a time window, and relational indexes handle that well. The one store with real embedded-to-cloud parity (SurrealDB) carries a BSL licence and a query language nobody on the project uses yet.

The harder call is retention, and the choice of store doesn't settle it. ADR 0001 forbids keeping raw tool input, and a graph that "holds all conversations" runs straight into that rule. This design keeps structure, pointers and short typed facts. Transcript text stays out of the durable graph unless someone opts in.

**Load-bearing assumption.** The brief assumes a graph *database* is what turns conversations into knowledge agents can use. That only holds if agents' real questions need traversals of three or more hops, or graph algorithms. It fails if most questions are "what's known about this file or area, recently", which an indexed edge table answers. To test it, log the queries agents send through the Phase 1 API for two to four weeks and count how many need three or more hops. Do that before paying for a graph server. The brief also skips two other explanations. Most of the value may come from *extraction quality*: which facts get written down and how fresh they stay. It also depends on *retention policy*: what may be kept at all. Changing the database fixes neither.

---

## 1. What is graph-shaped today

Most of the graph already exists as parsed fields spread across five stores. The registry is JSON, the claims file is JSON under a lock (`src/core/claims.ts:25`, `:122`), the feed is one SQLite database per project (`src/feed/store.ts:26-53`), the usage index is SQLite (`src/usage/schema.ts:106-143`), and transcripts are read in place.

| Entity | Where it comes from | Identity today | Notes |
|---|---|---|---|
| Session | `SessionEntry` (`src/core/types.ts:7-30`) | adapter-prefixed id, e.g. `claude-code:<uuid>` (`types.ts:8`) | `parentSessionId` links subagents to parents (`types.ts:18-29`) |
| Agent | `SessionEntry.adapter` (`types.ts:9`). The adapter dirs in `src/adapters/` are claude-code, codex, gemini, opencode, goose, copilot-cli, tmux, screen | adapter name | model is not normalized |
| Project (repo) | `projectIdentity()` (`src/feed/identity.ts:37-53`) | sha256 prefix of normalized origin remote, e.g. `gh:o/r` (`identity.ts:13`, `:28-35`) | no remote: falls back to git common dir, then real path. Both are machine-local |
| Worktree / branch | `FeedPost.scope.worktree/branch` (`src/feed/schema.ts`). Claude Code `raw.gitBranch` (`src/core/handoff.ts:353-360`) | free strings | branch is parsed only for Claude Code |
| Message / turn | `RawMessage` (`types.ts:54-60`) | (session, msgIndex) | text lives only in the agent's transcript |
| Tool call | `ToolCall` (`types.ts:45-52`), optional `id` | adapter id where kept | Codex normalization drops `call_id` (`src/adapters/codex/parse.ts:52-68`) |
| File | `inferTouchedFiles` / `inferWritingFiles` / `writeTargetsOfCommand` (`src/core/coordination.ts:354`, `:373`, `:505`). Also `FeedPost.scope.paths` and `FileClaim.files` (`types.ts:32-43`) | raw path string | absolute in claims and coordination, repo-relative in the feed |
| Commit | `PostEvidence.kind: "commit"` (`src/feed/schema.ts:11`), `--evidence commit:<sha>` (`src/cli/index.ts:709`) | sha | nothing ingests commits |
| Skill invocation | `Invocation` rows (`src/usage/schema.ts:19-82`), PK `(source_path, msg_index, call_index, source_kind)` | skill key via `src/skills/resolve.ts:56-63` | outcome is `unique \| ambiguous \| not-a-skill \| unmatched` (`src/skills/types.ts:85`) |
| Feed post | `FeedPost` (`src/feed/schema.ts`), 7 types | uuid | links `replyTo`, `supersedes`, `mentions`, typed `evidence` |
| Question / answer | post types `question` / `answer` + `replyTo` | post id | handoffs also regex-extract `openQuestions` (`handoff.ts:82`) |
| Handoff | `toHandoff()` (`handoff.ts:57-90`) | computed on demand, not stored | `decisions`, `openQuestions`, `nextActions` by regex (`handoff.ts:81-83`) |
| Claim | `FileClaim` (`types.ts:32-43`) in `~/.agent-peek/claims.json` | claim id | owner session, files, expiry |
| Derived signals | `deriveStatusPosts`, `deriveOverlapWarnings` (`src/feed/derive.ts:27`, `:92`) | post id | rule-based, already marked `origin: "derived"` |

Six things in the code limit graph quality. I'm flagging them here, not fixing them. Each one decides whether two observations of the same thing merge or split:

1. **Path identity is split.** Claims and coordination keep absolute paths. The feed keeps repo-relative ones. Absolute paths differ across worktrees and machines, so `/Users/a/wt-1/src/auth.ts` and `/home/b/repo/src/auth.ts` would become two File nodes.
2. **Codex loses the tool-call id.** `parse.ts:52-68` builds `ToolCall` without `call_id`, so a call can't be paired with its result in normalized form. The raw record still has the id.
3. **Session ids are machine-local and partly unstable.** Gemini falls back to a path-derived id while the session JSON is mid-write (`src/adapters/gemini/index.ts:30-33`), so one session can appear under two ids across scans. Copilot uses the directory entry name (`src/adapters/copilot-cli/index.ts:31`). A multi-machine graph needs a machine namespace in the id.
4. **Subagent attribution is half-populated.** The registry tracks subagents (`types.ts:18-29`), but usage `sidechain` / `attribution_agent` are false or null on every row (`src/usage/schema.ts:58-82`, "ticket 12").
5. **Commits are not ingested.** They show up only as post evidence and inside Bash command text.
6. **Projects without a remote don't merge across machines** (`identity.ts:45-52`).

## 2. Candidate schema

I recommend a property graph stored relationally: two tables, one FTS index, and an optional vector table later. Edges are rows keyed deterministically, so re-ingesting is an idempotent upsert and syncing from local to hosted is a copy, not a merge.

```sql
CREATE TABLE node (
  id          TEXT PRIMARY KEY,        -- deterministic, see id scheme below
  kind        TEXT NOT NULL,           -- session|agent|project|worktree|branch|machine|file|commit|toolcall|skill|post|claim|handoff|entity|fact
  project_id  TEXT,                    -- null for agent/machine/skill
  label       TEXT NOT NULL,           -- display key: repo-relative path, skill key, post title
  props       TEXT NOT NULL DEFAULT '{}',  -- JSON (jsonb on Postgres)
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE TABLE edge (
  id              TEXT PRIMARY KEY,    -- hash(kind, src, dst, qualifier)
  kind            TEXT NOT NULL,
  src             TEXT NOT NULL REFERENCES node(id),
  dst             TEXT NOT NULL REFERENCES node(id),
  project_id      TEXT,
  origin          TEXT NOT NULL,       -- parsed|heuristic|authored|derived|inferred
  confidence      REAL,                -- required when origin = inferred
  observed_at     TEXT NOT NULL,       -- when peek learned it (transaction time)
  valid_from      TEXT,                -- when it became true (event time)
  valid_to        TEXT,                -- set on invalidation, never deleted
  invalidated_by  TEXT,                -- edge/post id or 'drift'
  src_session     TEXT,                -- provenance pointer...
  src_msg_from    INTEGER,             -- ...into the transcript, not a copy of it
  src_msg_to      INTEGER,
  props           TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX node_kind_label ON node(kind, project_id, label);
CREATE INDEX edge_out  ON edge(src, kind, observed_at);
CREATE INDEX edge_in   ON edge(dst, kind, observed_at);
CREATE INDEX edge_proj ON edge(project_id, kind, observed_at);
CREATE VIRTUAL TABLE node_fts USING fts5(label, summary, content='');  -- only allow-listed text
```

The time columns follow Graphiti's bi-temporal model: event time (`valid_from`/`valid_to`) is tracked separately from learned time (`observed_at`).[^5] Old facts are invalidated, never deleted.

**Node id scheme.** `machine` = `m:<install-uuid>` (new; needed for cloud). `project` = `p:<hashKey(normalizeRemote(origin))>`, reusing `identity.ts`. `session` = `s:<machine>:<adapter>:<native-id>`. `file` = `f:<project>:<repo-relative-path>`, so worktree and branch go on the observing edge, not the file. `commit` = `c:<project>:<sha>`. `toolcall` = `t:<session>:<msgIndex>:<callIndex>`, which mirrors the usage PK. `post` keeps the feed uuid. Turns are *not* nodes by default. Edges point at `(session, msgIndex)` so the graph never holds message text.

| Edge | From → To | Origin | Source in code |
|---|---|---|---|
| `SPAWNED` | Session → Session | parsed | `parentSessionId` (`types.ts:29`) |
| `RAN_AS` | Session → Agent | parsed | `adapter` (`types.ts:9`) |
| `IN_PROJECT` | Session → Project | parsed | `cwd` → `projectIdentity` |
| `ON_BRANCH` | Session → Branch | parsed (Claude Code only) | `raw.gitBranch` (`handoff.ts:359`) |
| `RAN_ON` | Session → Machine | parsed (new) | install id |
| `CALLED` | Session → ToolCall | parsed | `RawMessage.toolCalls` |
| `INVOKED` | Session → Skill | parsed if resolution is `unique`; `INVOKED_AMBIGUOUS` with candidate keys otherwise | usage rows + `resolve.ts` |
| `READ` / `WROTE` | Session → File | heuristic | `inferTouchedFiles` / `inferWritingFiles` / `writeTargetsOfCommand` |
| `CLAIMS`, `OWNED_BY` | Claim → File, Claim → Session | parsed | `FileClaim` |
| `AUTHORED` | Session → Post | authored | `author.session` |
| `ABOUT` | Post → File | authored | `scope.paths` / `post_paths` (`store.ts:43-47`) |
| `REPLIES_TO`, `ANSWERS` | Post → Post | authored | `links.replyTo` (+ type) |
| `SUPERSEDES` | Post → Post | authored | `links.supersedes` |
| `MENTIONS` | Post → Session | authored | `links.mentions` |
| `CITES` | Post → File / Commit / Session | authored | `body.evidence` |
| `OVERLAPS` | Session ↔ Session (qualifier: file) | derived (rule) | `deriveOverlapWarnings` (`derive.ts:92`) |
| `CHANGED` | Commit → File | parsed (new, from `git log`) | — |
| `COMMITTED` | Session → Commit | heuristic (new: `git commit` in Bash + sha in output, or branch + time window) | — |
| `HANDED_OFF` | Session → Handoff → File | parsed + heuristic | `toHandoff` |
| `DECIDED`, `ASKED` | Session → Fact | heuristic today (regex hints), inferred later | `handoff.ts:81-83` |
| `MENTIONS_ENTITY` | Session / Post → Entity | inferred (LLM) | — |
| `RELATED_TO` | Session → Session | inferred (embedding) or derived (shared-file Jaccard) | — |
| `CO_CHANGES_WITH` | File → File | derived (counts over `WROTE`/`CHANGED`) | — |

Parsed and authored edges are deterministic and cheap, and they can always be rebuilt. Heuristic edges are deterministic but imprecise: the regex and command parsing already in the codebase. Inferred edges are non-deterministic. They carry `confidence`, the model id in `props`, and a provenance pointer, and anything a person or agent will read should land as a `derived` feed post (see §4).

## 3. Store options

Prices are the cheapest paid entry on each vendor's page as fetched. "Parity" means the same engine and query language running both on a laptop and in a hosted multi-machine setup.

| Store | Shape | Local ↔ cloud parity | Node/TS driver | Vector | Licence | Entry price (hosted) | Query | Health, 13 Nov 2026 |
|---|---|---|---|---|---|---|---|---|
| **Neo4j** | server (JVM) | good: Docker/Desktop locally, AuraDB hosted | official `neo4j-driver`, Apache-2.0, 6.x line[^14]; 64-bit ints come back as `neo4j.Integer`[^14b] | yes, Lucene-backed vector index[^12] | Community GPLv3[^13]; Enterprise commercial | AuraDB Free $0; Professional from $0.09/GB/hour, 1 GB min (≈ $66/mo, my arithmetic: 0.09 × 730 h)[^11] | Cypher | healthy; Community is single-instance, no clustering or online backup[^15] |
| **Memgraph** | server, in-memory | good: Docker locally; Memgraph Cloud (price not retrieved) | speaks Cypher and is Neo4j-compatible[^18]; using `neo4j-driver` over Bolt is training-data knowledge | yes, in Community[^16] | BSL 1.1 + Memgraph Enterprise License[^17] | Enterprise priced by memory, contact sales[^16] | Cypher | healthy; RAM sizes the bill |
| **FalkorDB** | server (Redis module) | good: Docker locally; FalkorDB Cloud (price not retrieved) | official JS client[^20] | yes, HNSW, 1–4096 dims[^20]; full-text index[^21] | **SSPLv1**: offering it as part of a service obliges you to open the service's source[^19] | not retrieved | OpenCypher subset over Redis protocol[^20] | healthy; successor to RedisGraph (EOL 31 Jan 2025)[^20] |
| **Postgres + Apache AGE** | extension | partial: any self-run Postgres; managed only where the provider ships AGE. Azure Flexible Server GA on PG 16/17/18 (May 2026)[^24]. RDS/Neon/Supabase not confirmed | `pg` + AGE's `setAGETypes` parser[^23] | none built in; pair with pgvector | Apache-2.0 (training data) | Azure Flexible Server pricing not retrieved | openCypher wrapped in SQL `cypher()`[^24] | active: v1.8.0 release candidates for PG18 and PG15 listed as "pending PMC approval"[^22] |
| **Postgres edges + pgvector** | server | good: Postgres everywhere; every major host ships pgvector[^25] | `pg`, postgres.js, Drizzle (mature; the workspace already uses Drizzle + pgvector on Postgres) | yes, pgvector 0.8.7, HNSW/IVFFlat[^25] | PostgreSQL licence (training data) | Neon free plan, "typical spend $15/month"[^26]; Supabase Pro from $25/mo incl. Micro compute[^27] | SQL + recursive CTE | healthy |
| **SQLite + recursive CTE (+ sqlite-vec)** | embedded, already in repo | local only; hosting needs a server around it or Postgres | `node:sqlite`, built into Node; repo requires ≥ 24 | sqlite-vec: stable v0.1.9 is brute-force; ANN (DiskANN, rescore) only in v0.1.10 alphas, last 18 May 2026[^28] | public domain; sqlite-vec permissive (training data) | $0 | SQL + recursive CTE | probe on Node v24.22.3: SQLite 3.54.1, FTS5 works, `loadExtension` present, recursive CTE and JSON functions work (§Research notes) |
| **libSQL / Turso** | embedded + cloud | good on paper | `@libsql/client`; Turso's newer `@tursodatabase/database` | native vector search, DiskANN[^33] | MIT | Free $0 (100 DBs, 5 GB); Developer $4.99/mo; Scaler $24.92/mo[^31] | SQL | libSQL is "where we started"; Turso recommends its Rust rewrite for new projects[^30]. libSQL crate has no concurrent writes[^32] |
| **Kùzu → LadybugDB** | embedded | local only; no managed service | `@ladybugdb/core` 0.22.3, native addon, 68,855 weekly downloads, updated 2026-11-06[^2] | yes, native vector + FTS[^2] | MIT[^2] | none | Cypher | **Kùzu archived 10 Oct 2025** (Apple acqui-hire per EC filing)[^1]. LadybugDB fork actively developed[^1]. Cognee calls it "one writer, one machine, no replication or failover"[^3] |
| **SurrealDB** | embedded, server, cloud | best on paper: one Rust engine embedded, WASM, single node, cluster[^36] | official JS SDK; Node embedded engine maturity not verified this session | yes, vector + full-text + hybrid[^36] | core BSL 1.1 (reserves running it as a DBaaS for third parties), SDKs Apache/MIT[^35] | Earth Free $0 (3M requests, 10 GB); Pro $15/mo launch price; Cloud from $0.021/node-hour[^34] | SurrealQL (graph via `RELATE`, training data) | healthy, 33k stars[^36] |

The table hides four things that decide the outcome.

*Licence vs. the hosted plan.* agent-peek is about to run a hosted service for other people's agents. Under SSPL, FalkorDB-as-part-of-a-service means opening the service's source or buying a licence. Memgraph's and SurrealDB's BSL terms restrict reselling the *database* as a service. A hosted agent-peek probably isn't that, but it would need a legal read. Neo4j Community's GPLv3 is fine for a network service, but it rules out clustering. Postgres has none of these questions.

*Parity is rare.* Only SurrealDB and Turso run one engine in both places. Everyone else needs Docker on every laptop, which is a big ask for an `npx` CLI with six runtime dependencies (`package.json`), or two engines. LadybugDB is the best local Cypher engine, but it has no cloud counterpart, so you'd end up maintaining Cypher against two dialects anyway.

*Vector search locally is immature.* sqlite-vec's ANN indexes are alpha, and the alpha.2 notes say DiskANN deletes are "quite expensive".[^28] Brute force is fine up to a few hundred thousand vectors (training-data rule of thumb, not measured here). Session-summary embeddings for one machine's 30-day window sit far below that.

*Kùzu is dead; its fork is young.* Version 0.x plus a native addon is a real install risk for a CLI. The npm package depends on `cmake-js`[^2], which implies a source build where no prebuilt binary matches. That's my inference.

### Memory frameworks built on graphs

| Framework | What it is | Backends | Fit for agent-peek |
|---|---|---|---|
| **Graphiti** | Python library, Apache-2.0, 32.8k stars[^4]; bi-temporal edges (`valid_at`/`invalid_at`, `created_at`/`expired_at`)[^5]; latest tag v0.29.3, 27 Jul 2026 (secondary source)[^6] | bring your own Neo4j, FalkorDB or Amazon Neptune; "self-hosted only"[^4] | Poor as a dependency. It needs a Python sidecar plus a graph server, and it makes an LLM call per raw episode, which ADR 0001's retention stance rules out. **Borrow its temporal model** (done in §2). |
| **Zep** | managed context graph built on Graphiti; TS/Python/Go SDKs[^4] | Zep's own store | Pricing is per write: 1 credit per episode up to 350 bytes, +1 per extra 350 bytes. Free 10k credits; Flex $125/mo for 50k; Flex Plus $375/mo for 200k[^7]. It ships transcripts to a third party. Community Edition is deprecated (secondary)[^8]. Contender only if that transfer is acceptable. |
| **Cognee** | Python memory engine, Apache-2.0 (secondary)[^9] | default embedded Ladybug; Neo4j/Aura/Neptune for production; its Postgres adapter is "demo, not production-ready"[^3] | Poor. Python, and its own docs push production to Neo4j. |
| **Mem0 graph** | memory layer; Node SDK v3.0.0, 16 Apr 2026[^10] | **graph memory was removed from open source in v3**; Platform-only[^9b] | Not viable self-hosted. |

None of the four is a drop-in for a TypeScript CLI that must work offline. What they offer is ideas: Graphiti's bi-temporal edges and episode provenance, and Zep's per-write pricing as a ceiling on what "managed" costs.

## 4. Ingestion and extraction pipeline

Ingestion should ride the cursors that already exist rather than adding a new crawler. Adapters already expose `CursorData { adapter, byteOffset, msgIndex, tail }` (`types.ts:62-70`). The usage index already keeps per-source `Watermark { cursor, msgIndex, size, mtimeMs, deleted }` and keeps them forever (`src/usage/schema.ts:85-98`). Extend the usage scan into a graph scan that shares those watermarks, so each transcript is read once per change.

1. **Parse (every scan, in-process, deterministic).** For each new message range, emit nodes and edges with deterministic ids. Dedupe with the usage table's trick: the PK is the source position `(source_path, msg_index, call_index)`, so a rescan rewrites the same rows. `last_seen` uses `max()`. Nothing is deleted when a transcript expires. Expiry only stops new observations, and that's why the graph has to be allow-listed (step 3).
2. **Resolve entities.** Files are rewritten to repo-relative paths at ingestion. Find the worktree root for the session `cwd` (`git rev-parse --show-toplevel`), strip it, and attach worktree and branch to the edge. A path outside any repo stays a machine-scoped `f:m:<machine>:<abs>` node and never merges. Repos use `projectIdentity` as is. Remote-less repos stay machine-local by design, and the doc should say so to users rather than guess. Sessions get a machine prefix. Gemini's path-fallback id needs a reconciliation edge (`SAME_AS`, origin `parsed`) once the real `sessionId` appears. Skills create an edge only on a `unique` resolution.
3. **Privacy gate (schema-enforced, same rule as ADR 0001).** By default the durable graph holds ids, timestamps, repo-relative paths, tool names, the ADR's whitelisted arguments, and the short text people or agents deliberately *authored* as feed posts. It never holds message text or raw tool input/output. Redaction is defence in depth, not the control. ADR 0001 rejected "store everything, redact" because its failure is "silent, permanent, and only discovered after the material has already been retained".

| Tier | What | Where | Default |
|---|---|---|---|
| Structure | nodes, parsed/heuristic edges, provenance pointers | local graph; synced to hosted | on |
| Authored / derived text | feed post titles and bodies (authored bodies ≤ 150 tokens, derived ≤ 40, `src/feed/schema.ts:65-66`) | local feed; synced to hosted | on, already true for the feed |
| Transcript text index | FTS over message text for "find where we discussed X" | local only; TTL = source transcript's lifetime (Claude Code: 30 days per ADR 0001) | **opt-in** |
| Hosted transcript text | anything beyond the above | hosted | **off; needs an explicit per-project consent decision** |

4. **Extract (async, batched, off the hot path).** LLM extraction runs at natural boundaries, never per message: when a session goes idle, at handoff, or on demand. Its input is the same compacted material the handoff builder already assembles (budgeted by `budgetChars`, `handoff.ts:31`), not the raw transcript. Its output is short facts (decisions, open questions, entities), written as `derived` posts plus `DECIDED`/`ASKED`/`MENTIONS_ENTITY` edges with confidence and model id. Writing them as posts reuses the feed's TTL, supersede and drift machinery, and humans can see and retract them.
5. **Who pays for extraction.** `buildHandoff` already supports `provider: "host"`, where the *calling agent* writes the document from `material` (`handoff.ts:125-133`). Extraction can use the same pattern, so agent-peek spends nothing: the agent already in the session does the work as part of a handoff. A configured runner (`HandoffRunner`, `handoff.ts:20-24`) covers background extraction. I didn't measure transcript token volume or retrieve current model prices, so there's no dollar figure here. Measure tokens per handoff `material` across a week of real sessions before turning on background extraction. One anchor: the usage-index comment counts 674 transcripts on the machine it was built against (`src/usage/schema.ts:64-66`). For comparison, Zep's own estimator puts 15,000 episodes a month at 700 bytes each on the $125 Flex plan.[^7]
6. **Temporal edges.** Facts go stale three ways, and each maps onto machinery that already exists. A newer fact supersedes an older one (`links.supersedes` → set `valid_to`, `invalidated_by`). The file a fact is about changes (feed `validity: "drifted"` with `driftedPaths` → mark dependent edges drifted, and ranking already multiplies drifted posts by 0.4, `rank.ts:51`). A TTL expires (per-type `DEFAULT_TTL_MS`, `schema.ts`). Structural edges such as `WROTE` are events, so they never go stale. Queries weight them by recency instead.

## 5. Indexing and the queries it serves

| Query | Path through the graph | Index that serves it | Served today? |
|---|---|---|---|
| "What do we know about file X?" | File ← `ABOUT` Post, File ← `WROTE` Session, File ← `CLAIMS` Claim, File ← Fact (1 hop) | `node_kind_label` + `edge_in(dst, kind, observed_at)` | partly: `post_paths_path` index (`store.ts:47`) covers posts only |
| "Who touched auth recently?" | Files with path prefix `src/auth/` or Entity "auth" ← `WROTE` Session → `RAN_AS` Agent (2 hops) | B-tree prefix on `label` + `edge_in` time range. Topic form needs FTS on post text or an inferred Entity | no: coordination is live-only |
| "Related past sessions" | Session → `WROTE` File ← `WROTE` Session (2 hops, Jaccard), plus vector kNN over session-summary embeddings | `edge_out` / `edge_in`; vector index (pgvector hosted; sqlite-vec optional locally) | no |
| "Open questions on this repo" | Post{type=question, project} with no incoming `ANSWERS` | `edge_proj` + anti-join | yes, in the feed |
| "What did S's subagents do?" | recursive `SPAWNED` from S, then `WROTE` / `CALLED` | recursive CTE on `edge_out` | no |
| "Which commits came out of this conversation?" | Session → `COMMITTED` Commit → `CHANGED` File | `edge_out` | no (no commit ingestion) |
| "Files that usually change with X" | `CO_CHANGES_WITH` (precomputed) or File ← `CHANGED` Commit → `CHANGED` File | `edge_in` / `edge_out` | no |

Every query above is at most two hops plus filters, except the subagent tree. That's an unbounded but shallow recursion, which recursive CTEs handle in both SQLite and Postgres (probe verified on Node 24).

**Relation to feed ranking: complement, not replacement.** The feed is a *push* channel. `packFeed` fills a token budget with posts scored by type weight × mention boost × path relevance × freshness half-life × validity × anonymity (`rank.ts:11-54`). The graph is a *pull* channel and a candidate generator. Two integration points keep `scorePost` the single ranker. First, graph queries return posts and sessions that `scorePost` orders. Second, `relevance()` gains one more signal: today it scores an exact path match 1, a same or nested directory 0.6, and anything else 0.2 (`rank.ts:28-41`). A graph-proximity term (a `CO_CHANGES_WITH` neighbour, or a file the reader's session wrote) slots in between the 0.2 floor and the 0.6 directory match. Replacing the feed would discard working TTL, drift and supersede logic for no gain.

## 6. Recommendation, priced

**Choose:** typed `node`/`edge` tables (§2). Local store: `node:sqlite` with FTS5 and recursive CTEs, in a new per-machine `graph.db` beside `usage.db`. Self-hosted store: the same SQLite schema inside Research B's `peek serve` (single node), so there is no second dialect until it's needed. Multi-tenant hosted store: Postgres + pgvector with the same schema, adopted when Research B's hosted multi-tenant option is. The pipeline is §4 with the privacy gate on by default, and the API is one narrow typed module, mirroring ADR 0001's "only public way to read the index".

**What improves.** No new runtime dependency or native addon locally, because `node:sqlite` is already how the feed and usage stores work. Joins between graph, feed and usage are plain local SQL. The self-host stage adds no new service. The multi-tenant stage is commodity Postgres: Neon free tier, or about $15–25/month for a small paid instance[^26][^27]. The workspace already runs Drizzle + pgvector on Postgres. Every licence is permissive. The retention boundary is enforced by the schema, matching the project's stated preference to fail "visibly, by not having the data".

**What gets worse.** Queries of three or more hops and path queries become verbose recursive CTEs and run slower than a native graph engine. Humans get no Cypher console for exploring. Once multi-tenant hosting arrives, two SQL dialects have to stay in lockstep (mitigated by the narrow API plus one shared test suite run against both). Until then everything is SQLite. Local vector search is brute-force until sqlite-vec's ANN leaves alpha. There are no built-in graph algorithms (PageRank, community detection) without exporting.

**What would reverse it.**
- The Phase 1 query log shows routine traversals of three or more hops, or a real need for graph algorithms. Then project the edge tables into Neo4j AuraDB (≈ $66/month minimum) or Memgraph as a hosted *read model*. The edge table exports directly to Cypher `MERGE`s, so nothing is lost.
- LadybugDB or SurrealDB proves a hosted multi-writer story with Node parity. Then reconsider a single engine.
- The user decides the cloud *should* keep full transcripts. That makes it a consent and retention design first. Zep becomes a contender only if sending transcripts to a third party is acceptable.

**Cost summary** (hosted, smallest paid tier, from fetched pages; ≈ figures are my arithmetic):

| Option | Monthly entry cost | Notes |
|---|---|---|
| Recommended, self-host stage: SQLite in `peek serve` | $0 software; the host machine is whatever runs `peek serve` | no new service |
| Recommended, multi-tenant stage: Postgres | Neon free / ≈ $15 typical[^26]; Supabase $25[^27] | pgvector included |
| Neo4j AuraDB Professional | ≈ $66 (1 GB min)[^11] | Business Critical ≈ $292 (2 GB min at $0.20/GB/h) |
| SurrealDB | $0 Free; $15 Pro; Cloud ≈ $15 per node (0.021 × 730)[^34] | BSL |
| Turso | $0 Free; $4.99 Developer; $24.92 Scaler[^31] | libSQL in maintenance; rewrite recommended |
| Zep (managed memory) | $125 Flex; $375 Flex Plus[^7] | per-write metering; third-party transfer |

## 7. Phasing without blocking off-localhost

Each phase starts only when the one before it is done. Phase 1 needs nothing from the off-localhost work.

Three of Research B's five Phase 0 portability fixes are also preconditions here, so the graph work should share them rather than duplicate them. *Claims in one global file with no repo-relative normalisation* is §1 item 1. *Drift checked against local file mtime* breaks the temporal step in §4: off one machine, drift has to come from commits or content hashes. *Self-asserted authors* makes `AUTHORED` edges untrustworthy once more than one machine writes, so in hosted mode attribution should come from the token's principal. The other two (wall-clock feed cursors, MCP defaulting to the server's `cwd`) don't touch the graph, which syncs by deterministic id, not by timestamp.

1. **Phase 0 — retention decision (no code).** Write ADR 0002: the graph stores structure, pointers, whitelisted arguments and authored or derived posts; transcript text is local-only and opt-in; hosted transcript text needs explicit per-project consent. *Exit:* the owner accepts the ADR.
2. **Phase 1 — local deterministic graph.** `graph.db` with the §2 schema, filled by an extended usage scan sharing its watermarks, plus a read-through of feed posts and claims. Ship machine-namespaced session ids and repo-relative file ids now. They cost little today and save a migration later. Fix-first items from §1: store Codex `call_id` and normalize claim paths. Add a read-only `peek graph` CLI and MCP tools that obey the ADR boundary, and log query shapes. *Exit:* the four brief queries answer locally in < 200 ms on a 30-day corpus (target, not measured).
3. **Phase 2 — hosted sync (after `peek serve` exists).** Each machine pushes node and edge rows into `peek serve`'s SQLite through its REST ingest, as idempotent upserts keyed by deterministic ids. Edges are append-plus-invalidate, so no CRDT or conflict resolution is needed, and `last_seen` is `max()`. The same typed API is served over remote MCP. Postgres replaces SQLite on the server only when hosted multi-tenancy is built. *Exit:* two machines' sessions on one repo resolve to the same Project and File nodes.
4. **Phase 3 — inferred layer.** Extraction at handoff or idle via the host-harness pattern, written as `derived` posts plus Fact/Entity edges with confidence. Session-summary embeddings go into pgvector once the server is on Postgres. On the SQLite tiers they go into sqlite-vec only once its ANN is stable; until then, shared-file Jaccard stands in for "related sessions". *Exit:* "related past sessions" is judged useful on a sample. The owner sets the bar.
5. **Phase 4 — reassess the store.** Read the query log against the reversal triggers in §6.

## 8. Risks and open decisions

**Decisions for the owner (Akhilesh):**
- Hosted retention: may the hosted graph hold derived facts from private repos, and may it ever hold transcript text?
- Extraction payer: host agent at handoff (free to agent-peek, but it runs only when someone hands off) versus a background runner (always on, costs model tokens).
- Remote-less repos: accept that they never merge across machines, or add a user-assigned project key.

**Risks.**
- Heuristic `WROTE` edges inherit the precision of `writeTargetsOfCommand`'s Bash parsing, and that precision was not measured in this research.
- The subagent gap (§1 item 4) hides about 32% of transcripts from usage on the build machine (218 of 674, `src/usage/schema.ts:64-66`) until ticket 12 lands. Graph completeness depends on it.
- If the Phase 1 API grows a free-form query tool, the ADR boundary is gone. Keep queries named and typed.

---

## Research notes

*Code probe, 13 Nov 2026, repo sandbox.* The sandbox default is Node v20.20.2, which has no `node:sqlite`. I ran `npx node@24`, which reported `node: v24.22.3`. `new DatabaseSync(":memory:", { allowExtension: true })` worked, `CREATE VIRTUAL TABLE … USING fts5` worked, and a `MATCH 'auth'` query returned the inserted row. `sqlite_version()` reported 3.54.1. `typeof db.loadExtension` and `typeof db.enableLoadExtension` both returned `function`. A recursive CTE returned 5 rows as expected, and `json_extract` worked. I didn't test loading sqlite-vec itself.

*Earlier this session I can't evidence from here:* a note that Kùzu's final npm release was 0.11.3. The doc relies on gdotv's archive date instead.[^1]

## Sources

All retrieved 13 Nov 2026. "Fetch" = full page read. "Snippet" = search-result excerpt only.

[^1]: [gdotv — Kuzu's Legacy and the New Wave of Embedded Graph Databases (28 May 2026)](https://gdotv.com/blog/kuzu-legacy-embedded-graph-database-landscape/). Fetch. Kùzu repo archived 10 Oct 2025; EC filing confirmed Apple acqui-hire; LadybugDB "actively developed"; FalkorDBLite "Python-first".
[^2]: [npm registry — @ladybugdb/core latest](https://registry.npmjs.org/@ladybugdb/core/latest). Fetch. v0.22.3, MIT, 68,855 weekly downloads, updated 2026-11-06, deps include cmake-js and node-addon-api; README: Cypher, native FTS and vector index, serializable ACID, "formerly known as Kuzu".
[^3]: [Cognee docs — Graph Stores](https://docs.cognee.ai/setup-configuration/graph-stores). Fetch. Ladybug default, "one writer, one machine, no replication or failover"; Postgres adapter "demo, not production-ready"; Neo4j recommended; Memgraph community-maintained.
[^4]: [GitHub — getzep/graphiti](https://github.com/getzep/graphiti/). Fetch. Apache-2.0, Python, 32,791 stars; Graphiti graph DB "Bring your own: Neo4j, FalkorDB, or Amazon Neptune"; "Self-hosted only"; Zep SDKs Python, TypeScript, Go.
[^5]: [Agent Memory Atlas — Graphiti](https://neoneye.github.io/agent-memory-atlas/systems/graphiti/). Snippet. Bi-temporal: `valid_at`/`invalid_at` vs `created_at`/`expired_at`.
[^6]: [Mnemoverse — Hindsight vs Graphiti (26 Aug 2026)](https://mnemoverse.com/docs/library/hindsight-vs-graphiti). Snippet. Latest tag v0.29.3 on 2026-07-27.
[^7]: [Zep — Pricing](https://www.getzep.com/pricing/). Fetch. Flex $125/mo with 50k credits; Flex Plus $375/mo with 200k; free 10k credits/mo; 1 credit per episode ≤ 350 bytes, +1 per additional 350 bytes; retrieval and storage 0 credits; estimator 15,000 episodes × 700 bytes → $125 Flex.
[^8]: [Memory Layer Index — Zep](https://www.memory-layer-index.info/tools/zep/). Snippet. "Zep Community Edition, the old self-hosted version, is deprecated."
[^9]: [Hivebook — Cognee](https://www.hivebook.wiki/wiki/cognee-memory-layer-for-ai-agents-using-knowledge-graphs). Snippet. Apache-2.0, PyPI package `cognee`, stable 1.5.3 (verified 2026-08-27 per that page).
[^9b]: [Mem0 docs — Platform vs Open Source](https://docs.mem0.ai/platform/platform-vs-oss). Fetch. OSS graph memory "Removed… dropped when the v3 pipeline landed"; Platform-only.
[^10]: [GitHub release — Mem0 Node SDK v3.0.0](https://github.com/mem0ai/mem0/releases/tag/ts-v3.0.0). Snippet. Published 2026-04-16.
[^11]: [Neo4j — Pricing](https://neo4j.com/pricing/). Fetch. AuraDB Free $0; Professional from $0.09/GB/hour (min 1 GB); Business Critical from $0.20/GB/hour (min 2 GB).
[^12]: [Neo4j Cypher Manual — Vector indexes](https://neo4j.com/docs/cypher-manual/current/indexes/search-indexes/vector-indexes/). Snippet. "powered by the Apache Lucene indexing and search library".
[^13]: [GitHub — neo4j README](https://github.com/neo4j/neo4j/blob/3.3/README.asciidoc) and [Fossies — VectorIndexProcedures.java header](https://fossies.org/linux/neo4j/community/procedure/src/main/java/org/neo4j/procedure/builtin/VectorIndexProcedures.java). Snippets. Community Edition GPLv3.
[^14]: [GitHub — neo4j/neo4j-javascript-driver](https://github.com/neo4j/neo4j-javascript-driver/). Snippet. Official driver, Apache-2.0, default branch 6.x.
[^14b]: [Neo4j llms-full.txt](https://neo4j.com/llms-full.txt). Snippet. JS integers returned as `neo4j.Integer`.
[^15]: [Neo4j Operations Manual — Introduction](https://neo4j.com/docs/operations-manual/5/introduction/). Snippet. CE for single-instance; EE adds backups, clustering, failover.
[^16]: [Memgraph — Pricing](https://memgraph.com/pricing). Fetch. Community "Free, forever", includes vector search and HA replication; Enterprise priced on memory.
[^17]: [GitHub — memgraph LICENSE](https://github.com/memgraph/memgraph/blob/master/LICENSE). Fetch. BSL 1.1 and Memgraph Enterprise License.
[^18]: [GitHub — memgraph/memgraph](https://github.com/memgraph/memgraph). Fetch. "fully compatible with Neo4j's Cypher"; built-in vector and text indexes.
[^19]: [FalkorDB docs — License](https://docs.falkordb.com/references/license). Fetch. SSPLv1; providing FalkorDB as part of a service requires open-sourcing that service's code.
[^20]: [FalkorDB docs — Vector Indexing](https://docs.falkordb.com/cypher/indexing/vector-index). Fetch. HNSW, cosine/euclidean, 1–4096 dims, JS example; Redis protocol, OpenCypher subset; RedisGraph EOL 31 Jan 2025.
[^21]: [FalkorDB docs — Full-Text Indexing](https://docs.falkordb.com/cypher/indexing/fulltext-index). Snippet (title only).
[^22]: [GitHub — apache/age releases](https://github.com/apache/age/releases). Fetch. v1.8.0 for PG18 (rc, 09 Jul) and PG15 (rc, 19 Sep; "pending Apache AGE PMC approval"); adds MERGE ON CREATE/ON MATCH, row-level security; year not shown on the page.
[^23]: [GitHub — apache/age drivers/nodejs README](https://github.com/apache/age/blob/master/drivers/nodejs/README.md). Fetch. `pg` client + `setAGETypes`; queries via `SELECT * FROM cypher(...)`.
[^24]: [Microsoft Community Hub — PostgreSQL as your Graph Database in the AI era (4 May 2026)](https://techcommunity.microsoft.com/blog/adforpostgresql/postgresql-as-your-graph-database-in-the-ai-era/4516323). Fetch. AGE GA on Azure Flexible Server on PG 16, 17, 18.
[^25]: [GitHub — pgvector/pgvector](https://github.com/pgvector/pgvector). Fetch. Install instructions pin v0.8.7; "preinstalled with… many hosted providers".
[^26]: [Neon — Pricing (updated 4 Nov 2026)](https://neon.com/pricing). Fetch. Page title "Free Plan With 100 Projects, Typical Spend $15/Month"; pgvector among extensions.
[^27]: [Supabase — Pricing](https://supabase.com/pricing). Fetch. Free $0 (500 MB, paused after 1 week inactive); Pro from $25/mo including $10 compute credit covering one Micro instance.
[^28]: [GitHub — asg017/sqlite-vec releases](https://github.com/asg017/sqlite-vec/releases). Fetch. v0.1.9 (31 Mar) stable; v0.1.10-alpha.1–4 add rescore and DiskANN ANN (ivf experimental), alpha.4 on 18 May; alpha.2 notes DiskANN DELETEs "quite expensive".
[^30]: [Turso docs — libSQL](https://docs.turso.tech/libsql). Fetch. "libSQL represents where we started… If you're starting a new project, we recommend Turso Database"; libSQL "adds features like native vector search".
[^31]: [Turso — Pricing](https://turso.tech/pricing). Fetch. Free $0 (100 DBs, 5 GB, 500M rows read); Developer $4.99/mo; Scaler $24.92/mo; Pro $416.58/mo (yearly-billing display).
[^32]: [Turso docs — Rust reference](https://docs.turso.tech/sdk/rust/reference). Snippet. `libsql` crate: concurrent writes "Not supported"; `turso` crate: MVCC.
[^33]: [Turso blog — Databases for all your AI apps](https://turso.tech/blog/databases-for-all-your-ai-apps). Snippet. Native vector search GA with DiskANN indexing.
[^34]: [SurrealDB — Pricing](https://surrealdb.com/pricing). Fetch. Earth Free $0 (3M requests, 10 GB, 100 db hours); Pro $15/mo launch price; Cloud from $0.021/hr per node.
[^35]: [SurrealDB — Licence FAQ](https://surrealdb.com/license). Fetch. Core BSL 1.1, Apache-2.0 "within four years"; reserves running SurrealDB as a database service for third parties; SDKs Apache-2.0 or MIT.
[^36]: [GitHub — surrealdb/surrealdb](https://github.com/surrealdb/surrealdb). Fetch. 33,308 stars; runs embedded, in browser via WASM, single node or cluster; full-text, vector and hybrid search.

Also fetched for the Node probe context: [Node.js docs — SQLite](https://nodejs.org/api/sqlite.html) (snippet: titles list `allowExtension`, `loadExtension`, `enableLoadExtension`).

Sibling research read on 13 Nov 2026: *Research B — off-localhost cloud-agent architecture options* ([research-b-cloud-architecture.md](research-b-cloud-architecture.md)). It recommends a self-hostable `peek serve` (Streamable HTTP MCP + REST ingest, single-node SQLite, per-project scoped tokens) after five Phase 0 portability fixes, and structured status rather than raw transcripts by default.
