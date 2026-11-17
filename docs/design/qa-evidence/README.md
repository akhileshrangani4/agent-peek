# QA evidence from the 0.7 PRs

Test transcripts recorded while PRs #14–#20 were built and reviewed, before each merged into `release/0.7.0`. They were exported from the design workspace on 2026-11-17 and are byte-for-byte copies of the uploads. Upload names (`tc-N-result.txt`, `tc-N-before.txt`, `tc-N-after.txt`) restart at `tc-1` for every PR, so files are filed by PR. `tc-N` is the PR's N-th acceptance check. In PR #20, `before` and `after` are the same check run without and with the change. In PR #19, `result` and `after` are the same three checks at its two review heads (before and after its rebase). PR #15 uploaded only `after` runs.

Each transcript was attributed from its own contents (a PR number or head SHA in its first line, or test names only that PR added), cross-checked against its upload time. All 37 were attributed; `unattributed/` is not needed.

| PR | Title | Head SHA on GitHub | SHA named in transcripts | Files |
|---|---|---|---|---|
| [#14](https://github.com/akhileshrangani4/agent-peek/pull/14) | feat: ADR 0002 export boundary and assertExportable guard (D1) | `957fc8e` | none (see note) | 2 |
| [#15](https://github.com/akhileshrangani4/agent-peek/pull/15) | fix(adapters): Goose, Copilot, Codex and env-override correctness (D3.6, D3.7) | `26accad` | none (see note) | 2 |
| [#16](https://github.com/akhileshrangani4/agent-peek/pull/16) | test: golden-output parity harness for CLI and stdio MCP (D3.1 baseline) | `0da5270` | `0da5270` | 3 |
| [#17](https://github.com/akhileshrangani4/agent-peek/pull/17) | feat(opencode): land the V2 SQLite adapter from #12 with compatibility fixes | `cb16d35` | `cb16d35` | 9 |
| [#18](https://github.com/akhileshrangani4/agent-peek/pull/18) | fix(handoff): real signal in decisions and questions, and a session goal (D9.3, D9.4; #1, #2, #6) | `2644bdc` | `2644bdc` | 3 |
| [#19](https://github.com/akhileshrangani4/agent-peek/pull/19) | refactor(app): shared service layer and MCP tool registry (D3.1, D3.2, D3.8) | `98a7d7a` | `63f50b3`, `98a7d7a` | 6 |
| [#20](https://github.com/akhileshrangani4/agent-peek/pull/20) | fix(coordination): per-call path resolution and handoff file roles (D9.1, D9.2; #7, #1) | `f20c849` | `f20c849` | 12 |
| | | | **Total** | **37** |

## PR #14: feat: ADR 0002 export boundary and assertExportable guard (D1)

Head `957fc8e0a523ed6520dfb4556810717a0ec50d7d`, merged 2026-11-13T22:37:39Z as `22ecda6`.

- No SHA in the transcript. Attributed by content: the ADR 0002 (D1.1) docs tests and `test/export/assert-exportable.test.ts` exist only in PR #14's diff; uploaded 22:36 UTC, 1.5 minutes before #14 merged.

| File | Uploaded (UTC) | Contents |
|---|---|---|
| [`tc-1-result.txt`](pr-14/tc-1-result.txt) | 2026-11-13 22:36:07 | `test/docs.test.ts`, `test/export/assert-exportable.test.ts`; tests 39 passed (39) |
| [`tc-2-result.txt`](pr-14/tc-2-result.txt) | 2026-11-13 22:36:09 | `test/docs.test.ts`, `test/export/assert-exportable.test.ts`; tests 39 passed (39) |

## PR #15: fix(adapters): Goose, Copilot, Codex and env-override correctness (D3.6, D3.7)

Head `26accad990630d4514c9353e476a464e3c4de241`, merged 2026-11-13T22:39:44Z as `3d95d1a`.

- No SHA in the transcript. Attributed by content: the Goose multi-session usage-scan tests and the Codex `call_id` tests exist only in PR #15's diff; uploaded 22:38 UTC, 1.5 minutes before #15 merged.

| File | Uploaded (UTC) | Contents |
|---|---|---|
| [`tc-1-after.txt`](pr-15/tc-1-after.txt) | 2026-11-13 22:38:15 | `test/usage-scan-sources.test.ts`; tests 7 passed (7) |
| [`tc-2-after.txt`](pr-15/tc-2-after.txt) | 2026-11-13 22:38:16 | `test/adapters/claude-code.test.ts`, `test/adapters/codex.test.ts`, `test/adapters/goose.test.ts`; tests 28 passed (28) |

## PR #16: test: golden-output parity harness for CLI and stdio MCP (D3.1 baseline)

Head `0da5270fc402ee34949939c5483d9cb8b62968b7`, merged 2026-11-13T22:43:53Z as `5e40e0e`.

- Each transcript names head `0da5270`, PR #16's head.

| File | Uploaded (UTC) | Contents |
|---|---|---|
| [`tc-1-result.txt`](pr-16/tc-1-result.txt) | 2026-11-13 22:43:20 | head: 0da5270fc402ee34949939c5483d9cb8b62968b7, CI=true (no snapshot writes), Node v24.22.3; `test/golden/cli.golden.test.ts`; tests 81 passed (81) |
| [`tc-2-result.txt`](pr-16/tc-2-result.txt) | 2026-11-13 22:43:21 | head: 0da5270fc402ee34949939c5483d9cb8b62968b7, CI=true (no snapshot writes), Node v24.22.3; `test/golden/mcp.golden.test.ts`; tests 81 passed (81) |
| [`tc-3-result.txt`](pr-16/tc-3-result.txt) | 2026-11-13 22:43:22 | head: 0da5270fc402ee34949939c5483d9cb8b62968b7, CI=true (no snapshot writes), Node v24.22.3; `test/golden/harness.test.ts`; tests 81 passed (81) |

## PR #17: feat(opencode): land the V2 SQLite adapter from #12 with compatibility fixes

Head `cb16d35fd04d2570370fcdedcdfe8ea16b15695e`, merged 2026-11-13T23:01:33Z as `20fde50`.

- Each transcript names head `cb16d35`, PR #17's head.

| File | Uploaded (UTC) | Contents |
|---|---|---|
| [`tc-1-result.txt`](pr-17/tc-1-result.txt) | 2026-11-13 23:00:55 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/adapters/opencode.test.ts`, `test/golden/opencode-legacy.golden.test.ts`; tests 6 passed / 15 skipped (21) |
| [`tc-2-result.txt`](pr-17/tc-2-result.txt) | 2026-11-13 23:00:56 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/adapters/opencode.test.ts`; tests 3 passed / 14 skipped (17) |
| [`tc-3-result.txt`](pr-17/tc-3-result.txt) | 2026-11-13 23:00:57 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/adapters/opencode-engine.test.ts`, `test/adapters/opencode.test.ts`; tests 3 passed / 15 skipped (18) |
| [`tc-4-result.txt`](pr-17/tc-4-result.txt) | 2026-11-13 23:00:58 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/adapters/opencode.test.ts`; tests 1 passed / 16 skipped (17) |
| [`tc-5-result.txt`](pr-17/tc-5-result.txt) | 2026-11-13 23:00:59 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/adapters/opencode.test.ts`; tests 1 passed / 16 skipped (17) |
| [`tc-6-result.txt`](pr-17/tc-6-result.txt) | 2026-11-13 23:01:00 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e |
| [`tc-7-result.txt`](pr-17/tc-7-result.txt) | 2026-11-13 23:01:01 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/adapters/opencode.test.ts`; tests 7 passed / 10 skipped (17) |
| [`tc-8-result.txt`](pr-17/tc-8-result.txt) | 2026-11-13 23:01:02 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/adapters/opencode-engine.test.ts`, `test/unit/loader.test.ts`; tests 7 passed (7) |
| [`tc-9-result.txt`](pr-17/tc-9-result.txt) | 2026-11-13 23:01:02 | head: cb16d35fd04d2570370fcdedcdfe8ea16b15695e; `test/golden/cli.golden.test.ts`; tests 1 passed / 39 skipped (40) |

## PR #18: fix(handoff): real signal in decisions and questions, and a session goal (D9.3, D9.4; #1, #2, #6)

Head `2644bdcfa48cdcd3fd0c1d57ccdf8b18941858ff`, merged 2026-11-13T23:35:49Z as `5fc859d`.

- Each transcript names head `2644bdc`, PR #18's head (`2644bdcfa4…`).

| File | Uploaded (UTC) | Contents |
|---|---|---|
| [`tc-1-result.txt`](pr-18/tc-1-result.txt) | 2026-11-13 23:34:46 | head 2644bdc; `test/unit/handoff-signal.test.ts`, `test/unit/handoff.test.ts`; tests 43 passed / 23 skipped (66) |
| [`tc-2-result.txt`](pr-18/tc-2-result.txt) | 2026-11-13 23:34:47 | head 2644bdc; `test/unit/handoff.test.ts`, `test/unit/snapshot.test.ts`; tests 14 passed / 42 skipped (56) |
| [`tc-3-result.txt`](pr-18/tc-3-result.txt) | 2026-11-13 23:34:48 | head 2644bdc; `test/golden/cli.golden.test.ts`, `test/golden/harness.test.ts`, `test/golden/mcp.golden.test.ts` and 1 more; tests 90 passed (90) |

## PR #19: refactor(app): shared service layer and MCP tool registry (D3.1, D3.2, D3.8)

Head `98a7d7aaac47acc1e8dc29ee1ab3e0409803935f`, merged 2026-11-14T00:16:57Z as `8f59094`.

- Round 1. Each transcript names `63f50b3` and criteria D3.1, D3.2, D3.8 (PR #19's). That SHA is #19's first 14 commits on `release/0.7.0@5fc859d`, before #19 was force-pushed (rebased onto #20) at 00:14 UTC.
- Round 2, after the rebase. Each transcript names `98a7d7a`, PR #19's final head, on base `f987adf` (#20 merged).

| File | Uploaded (UTC) | Contents |
|---|---|---|
| [`tc-1-result.txt`](pr-19/tc-1-result.txt) | 2026-11-13 23:59:36 | D3.1 golden suite at 63f50b37c4a5d64a70af947561593cd2e46aec36 (node v24.22.3); `test/golden/cli.golden.test.ts`, `test/golden/harness.test.ts`, `test/golden/mcp.golden.test.ts` and 1 more; tests 90 passed (90) |
| [`tc-2-result.txt`](pr-19/tc-2-result.txt) | 2026-11-13 23:59:45 | D3.2 architecture boundary at 63f50b37c4a5d64a70af947561593cd2e46aec36; `test/architecture.test.ts`; tests 7 passed (7) |
| [`tc-3-result.txt`](pr-19/tc-3-result.txt) | 2026-11-13 23:59:46 | D3.8 coverage at 63f50b37c4a5d64a70af947561593cd2e46aec36 (vitest run --coverage, v8, node v24.22.3); tests 893 passed (893) |
| [`tc-1-after.txt`](pr-19/tc-1-after.txt) | 2026-11-14 00:16:30 | D3.1 golden suite at 98a7d7aaac47acc1e8dc29ee1ab3e0409803935f (node v24.22.3), base release/0.7.0 f987adf (#20); `test/app/paths-routing.test.ts`, `test/golden/cli.golden.test.ts`, `test/golden/harness.test.ts` and 3 more; tests 90 passed (90) |
| [`tc-2-after.txt`](pr-19/tc-2-after.txt) | 2026-11-14 00:16:31 | D3.2 architecture boundary at 98a7d7aaac47acc1e8dc29ee1ab3e0409803935f; `test/architecture.test.ts`; tests 7 passed (7) |
| [`tc-3-after.txt`](pr-19/tc-3-after.txt) | 2026-11-14 00:16:32 | D3.8 coverage at 98a7d7aaac47acc1e8dc29ee1ab3e0409803935f (vitest run --coverage, v8, node v24.22.3); tests 949 passed (949) |

## PR #20: fix(coordination): per-call path resolution and handoff file roles (D9.1, D9.2; #7, #1)

Head `f20c84941ecb48d456e4680ad1a5a555d39cbf09`, merged 2026-11-14T00:09:43Z as `f987adf`.

- Each transcript names PR #20 and head `f20c849`; the `before` files ran #20's new test on `release/0.7.0@5fc859d`.

| File | Uploaded (UTC) | Contents |
|---|---|---|
| [`tc-1-result.txt`](pr-20/tc-1-result.txt) | 2026-11-14 00:08:38 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/adapters/codex-code-mode.test.ts`, `test/unit/coordination-paths.test.ts`, `test/unit/handoff.test.ts`; tests 3 passed / 73 skipped (76) |
| [`tc-2-result.txt`](pr-20/tc-2-result.txt) | 2026-11-14 00:08:53 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/unit/coordination-paths.test.ts`; tests 1 passed / 23 skipped (24) |
| [`tc-3-before.txt`](pr-20/tc-3-before.txt) | 2026-11-14 00:08:55 | BEFORE: release/0.7.0 @ 5fc859df88a7f5412f450cafec3ce3416036b310 with this PR's test added — Node v24.22.3; `test/integration/cli.test.ts` |
| [`tc-3-after.txt`](pr-20/tc-3-after.txt) | 2026-11-14 00:08:55 | AFTER: PR #20 head @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 (after npm run build); `test/integration/cli.test.ts`; tests 1 passed / 34 skipped (35) |
| [`tc-4-result.txt`](pr-20/tc-4-result.txt) | 2026-11-14 00:08:56 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/unit/coordination-paths.test.ts`; tests 3 passed / 21 skipped (24) |
| [`tc-5-result.txt`](pr-20/tc-5-result.txt) | 2026-11-14 00:08:57 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/unit/handoff.test.ts`; tests 2 passed / 41 skipped (43) |
| [`tc-6-result.txt`](pr-20/tc-6-result.txt) | 2026-11-14 00:08:58 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/unit/handoff.test.ts`; tests 2 passed / 41 skipped (43) |
| [`tc-7-result.txt`](pr-20/tc-7-result.txt) | 2026-11-14 00:08:58 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/unit/handoff.test.ts`; tests 1 passed / 42 skipped (43) |
| [`tc-8-result.txt`](pr-20/tc-8-result.txt) | 2026-11-14 00:09:00 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/unit/handoff.test.ts`; tests 1 passed / 42 skipped (43) |
| [`tc-9-result.txt`](pr-20/tc-9-result.txt) | 2026-11-14 00:09:01 | agent-peek PR #20 @ f20c84941ecb48d456e4680ad1a5a555d39cbf09 — Node v24.22.3; `test/golden/cli.golden.test.ts`, `test/golden/harness.test.ts`, `test/golden/mcp.golden.test.ts` and 1 more; tests 842 passed (842) |
| [`tc-10-before.txt`](pr-20/tc-10-before.txt) | 2026-11-14 00:09:02 | BEFORE: release/0.7.0 @ 5fc859df88a7f5412f450cafec3ce3416036b310 with this PR's test added — Node v24.22.3; `test/unit/engine.test.ts` |
| [`tc-10-after.txt`](pr-20/tc-10-after.txt) | 2026-11-14 00:09:02 | AFTER: PR #20 head @ f20c84941ecb48d456e4680ad1a5a555d39cbf09; `test/unit/engine.test.ts`; tests 1 passed / 21 skipped (22) |
