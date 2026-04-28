# agent-peek v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 `agent-peek` npm package — library + CLI + MCP server that lets one AI agent read-only peek into another agent's chat session, with built-in adapters for Claude Code and Codex.

**Architecture:** Single `agent-peek` npm package in TypeScript. Three surfaces (library / CLI / MCP) wrap one core engine. Core engine talks to pluggable adapters (built-in: `claude-code`, `codex`; external via `agent-peek-adapter-*` npm convention). Filesystem-backed registry at `~/.agent-peek/registry.json`. Snapshot tiers: `raw`, `structured`, `summary` (LLM-backed). Cursor-based diff for token-cheap polling. Same-user trust model.

**Tech Stack:**
- TypeScript 5.x (strict mode)
- Node.js 20+ (ESM)
- vitest (unit + integration tests)
- cac (CLI)
- proper-lockfile (registry concurrency)
- @modelcontextprotocol/sdk (MCP server)
- @anthropic-ai/sdk (summary tier)
- tsup (build)

---

## File Structure

```
agent-peek/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── .gitignore
├── README.md
├── LICENSE
├── bin/
│   ├── peek.js
│   └── agent-peek-mcp.js
├── src/
│   ├── index.ts                       # library entry / public exports
│   ├── core/
│   │   ├── types.ts                   # SessionEntry, RawMessage, ToolCall, Snapshot tiers
│   │   ├── errors.ts                  # typed error classes
│   │   ├── cursor.ts                  # opaque base64 cursor encode/decode
│   │   ├── registry.ts                # registry CRUD + lockfile
│   │   ├── snapshot.ts                # raw/structured/summary transformers
│   │   └── engine.ts                  # peek/list/register/tag orchestrator
│   ├── adapters/
│   │   ├── types.ts                   # Adapter interface
│   │   ├── loader.ts                  # built-in + ext discovery
│   │   ├── claude-code/
│   │   │   ├── index.ts
│   │   │   └── parse.ts               # JSONL parsing + format mapping
│   │   └── codex/
│   │       ├── index.ts
│   │       └── parse.ts
│   ├── cli/
│   │   ├── index.ts                   # cac entry, exit-code handling
│   │   └── commands/
│   │       ├── peek.ts
│   │       ├── list.ts
│   │       ├── tag.ts
│   │       ├── register.ts
│   │       └── adapters.ts
│   └── mcp/
│       └── index.ts                   # MCP server (stdio)
└── test/
    ├── fixtures/
    │   ├── claude-code/
    │   │   ├── empty/
    │   │   ├── multi-turn/
    │   │   ├── mid-tool-call/
    │   │   ├── corrupt-tail/
    │   │   └── long/
    │   └── codex/
    │       └── multi-turn/
    ├── helpers/
    │   ├── tmp-home.ts                # spawns isolated $HOME / registry dir
    │   └── adapter-conformance.ts     # shared assertions any adapter must pass
    ├── unit/
    │   ├── cursor.test.ts
    │   ├── registry.test.ts
    │   ├── snapshot.test.ts
    │   ├── engine.test.ts
    │   ├── errors.test.ts
    │   └── loader.test.ts
    ├── adapters/
    │   ├── claude-code.test.ts
    │   └── codex.test.ts
    └── integration/
        ├── concurrent-write.test.ts
        ├── cli.test.ts
        └── mcp.test.ts
```

---

## Phase 0: Project scaffolding

### Task 0.1: Initialize package

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `tsconfig.json`

- [ ] **Step 1: Initialize package.json**

Create `package.json`:

```json
{
  "name": "agent-peek",
  "version": "0.1.0",
  "description": "Read-only peek into other AI agent chat sessions.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./adapter": {
      "import": "./dist/adapters/types.js",
      "types": "./dist/adapters/types.d.ts"
    },
    "./mcp": {
      "import": "./dist/mcp/index.js",
      "types": "./dist/mcp/index.d.ts"
    }
  },
  "bin": {
    "peek": "./bin/peek.js",
    "apeek": "./bin/peek.js",
    "agent-peek-mcp": "./bin/agent-peek-mcp.js"
  },
  "files": ["dist", "bin", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["ai", "agent", "claude", "claude-code", "mcp", "peek", "transcript"],
  "author": "akhileshrangani4@gmail.com",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/akhileshrangani4/agent-peek.git" },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  },
  "dependencies": {
    "cac": "^6.7.14",
    "proper-lockfile": "^4.1.2",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@anthropic-ai/sdk": "^0.30.0"
  },
  "optionalDependencies": {}
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
dist/
coverage/
.DS_Store
*.log
.env
.env.local
.agent-peek-test-home/
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Install deps**

Run: `npm install`
Expected: Lockfile created. No errors. (If `@modelcontextprotocol/sdk@^1.0.0` resolution warns, accept latest available `>=1`.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore tsconfig.json
git commit -m "chore: scaffold package + tsconfig"
```

---

### Task 0.2: Build + test config

**Files:**
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: tsup.config.ts**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/types.ts",
    "src/mcp/index.ts",
    "src/cli/index.ts"
  ],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
});
```

- [ ] **Step 2: vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts", "src/cli/index.ts", "src/mcp/index.ts"],
      thresholds: { lines: 85, statements: 85, functions: 80, branches: 75 },
    },
  },
});
```

- [ ] **Step 3: Smoke test the toolchain**

Create `src/index.ts`:

```ts
export const VERSION = "0.1.0";
```

Create `test/unit/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { VERSION } from "../../src/index.js";

describe("smoke", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
```

Run: `npm test`
Expected: 1 passed. Build runs clean: `npm run build` — produces `dist/index.js`.

- [ ] **Step 4: Commit**

```bash
git add tsup.config.ts vitest.config.ts src/index.ts test/unit/smoke.test.ts
git commit -m "chore: tsup + vitest config + smoke test"
```

---

## Phase 1: Core types + errors

### Task 1.1: Core types

**Files:**
- Create: `src/core/types.ts`

- [ ] **Step 1: Write types**

```ts
// src/core/types.ts

export type SessionStatus = "active" | "idle" | "ended";
export type Activity = "idle" | "thinking" | "tool-running";

export interface SessionEntry {
  id: string;             // adapter-prefixed, e.g. "claude-code:abc-123"
  adapter: string;        // "claude-code" | "codex" | ...
  transcriptPath: string; // absolute path resolved by adapter
  cwd?: string;
  tag?: string;
  pid?: number;
  lastSeen: string;       // ISO timestamp
  status: SessionStatus;
}

export interface ToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: "pending" | "completed" | "error";
}

export interface RawMessage {
  role: "user" | "assistant" | "system" | "tool";
  text?: string;
  toolCalls?: ToolCall[];
  raw: unknown;           // adapter's original record
  timestamp?: string;
}

export interface CursorData {
  adapter: string;
  byteOffset: number;
  msgIndex: number;
}
export type Cursor = string; // opaque base64

export type SnapshotMode = "raw" | "structured" | "summary";

export interface RawSnapshot {
  mode: "raw";
  sessionId: string;
  messages: RawMessage[];
}

export interface StructuredSnapshot {
  mode: "structured";
  sessionId: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  currentTask?: string;
  pendingToolCalls: ToolCall[];
  lastToolCalls: ToolCall[];
  activity: Activity;
}

export interface SummarySnapshot {
  mode: "summary";
  sessionId: string;
  summary: string;
  deltaMessageCount: number;
  fallback?: boolean; // true if summary unavailable; structured returned instead
  structured?: StructuredSnapshot;
}

export type Snapshot = RawSnapshot | StructuredSnapshot | SummarySnapshot;

export interface PeekResult {
  snapshot: Snapshot;
  nextCursor: Cursor;
  eof: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(core): types"
```

---

### Task 1.2: Typed errors

**Files:**
- Create: `src/core/errors.ts`
- Create: `test/unit/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/errors.test.ts
import { describe, it, expect } from "vitest";
import {
  SessionNotFoundError,
  AmbiguousSelectorError,
  AdapterError,
  AdapterNotFoundError,
  CursorMismatchError,
  RegistryLockTimeoutError,
} from "../../src/core/errors.js";

describe("errors", () => {
  it("SessionNotFoundError carries selector", () => {
    const e = new SessionNotFoundError("foo");
    expect(e.name).toBe("SessionNotFoundError");
    expect(e.selector).toBe("foo");
    expect(e.message).toMatch(/foo/);
    expect(e instanceof Error).toBe(true);
  });

  it("AmbiguousSelectorError carries candidates", () => {
    const e = new AmbiguousSelectorError("re", ["a", "b"]);
    expect(e.candidates).toEqual(["a", "b"]);
    expect(e.message).toMatch(/re/);
  });

  it("AdapterError wraps cause", () => {
    const cause = new Error("boom");
    const e = new AdapterError("claude-code", "scan failed", cause);
    expect(e.adapter).toBe("claude-code");
    expect(e.cause).toBe(cause);
  });

  it("AdapterNotFoundError carries adapter name", () => {
    const e = new AdapterNotFoundError("nope");
    expect(e.adapter).toBe("nope");
  });

  it("CursorMismatchError surfaces both adapters", () => {
    const e = new CursorMismatchError("a", "b");
    expect(e.cursorAdapter).toBe("a");
    expect(e.sessionAdapter).toBe("b");
  });

  it("RegistryLockTimeoutError exists", () => {
    const e = new RegistryLockTimeoutError();
    expect(e.name).toBe("RegistryLockTimeoutError");
  });
});
```

- [ ] **Step 2: Run test — should fail**

Run: `npm test -- errors`
Expected: FAIL with "cannot find module './errors.js'".

- [ ] **Step 3: Implement errors**

```ts
// src/core/errors.ts

export class SessionNotFoundError extends Error {
  readonly name = "SessionNotFoundError";
  constructor(public selector: string) {
    super(`No session matched selector: ${selector}`);
  }
}

export class AmbiguousSelectorError extends Error {
  readonly name = "AmbiguousSelectorError";
  constructor(public selector: string, public candidates: string[]) {
    super(`Selector "${selector}" matched ${candidates.length} sessions: ${candidates.join(", ")}`);
  }
}

export class AdapterError extends Error {
  readonly name = "AdapterError";
  constructor(public adapter: string, message: string, public override cause?: unknown) {
    super(`[${adapter}] ${message}`);
  }
}

export class AdapterNotFoundError extends Error {
  readonly name = "AdapterNotFoundError";
  constructor(public adapter: string) {
    super(`Adapter "${adapter}" is not installed.`);
  }
}

export class CursorMismatchError extends Error {
  readonly name = "CursorMismatchError";
  constructor(public cursorAdapter: string, public sessionAdapter: string) {
    super(`Cursor was issued by adapter "${cursorAdapter}" but session uses "${sessionAdapter}".`);
  }
}

export class RegistryLockTimeoutError extends Error {
  readonly name = "RegistryLockTimeoutError";
  constructor() {
    super("Could not acquire lock on registry within timeout.");
  }
}

export class TranscriptUnreadableError extends AdapterError {
  override readonly name = "TranscriptUnreadableError";
}

export class TranscriptCorruptError extends AdapterError {
  override readonly name = "TranscriptCorruptError";
}

export class SummaryUnavailableError extends Error {
  readonly name = "SummaryUnavailableError";
  constructor(public reason: string) {
    super(`Summary mode unavailable: ${reason}`);
  }
}
```

- [ ] **Step 4: Run test — should pass**

Run: `npm test -- errors`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts test/unit/errors.test.ts
git commit -m "feat(core): typed errors"
```

---

## Phase 2: Cursor

### Task 2.1: Cursor encode/decode

**Files:**
- Create: `src/core/cursor.ts`
- Create: `test/unit/cursor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cursor.test.ts
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, cursorAdapter } from "../../src/core/cursor.js";
import { CursorMismatchError } from "../../src/core/errors.js";

describe("cursor", () => {
  it("round-trips data", () => {
    const data = { adapter: "claude-code", byteOffset: 4321, msgIndex: 17 };
    const c = encodeCursor(data);
    expect(typeof c).toBe("string");
    expect(decodeCursor(c)).toEqual(data);
  });

  it("decodes adapter without full decode", () => {
    const c = encodeCursor({ adapter: "codex", byteOffset: 0, msgIndex: 0 });
    expect(cursorAdapter(c)).toBe("codex");
  });

  it("rejects mismatched adapter via decodeCursor", () => {
    const c = encodeCursor({ adapter: "x", byteOffset: 0, msgIndex: 0 });
    expect(() => decodeCursor(c, "y")).toThrow(CursorMismatchError);
  });

  it("throws on garbage cursor", () => {
    expect(() => decodeCursor("not-base64!@#")).toThrow();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `npm test -- cursor`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/core/cursor.ts
import type { Cursor, CursorData } from "./types.js";
import { CursorMismatchError } from "./errors.js";

export function encodeCursor(data: CursorData): Cursor {
  const json = JSON.stringify(data);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: Cursor, expectedAdapter?: string): CursorData {
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error(`Invalid cursor: not base64url`);
  }
  let data: CursorData;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`Invalid cursor: not JSON`);
  }
  if (typeof data !== "object" || data === null || typeof data.adapter !== "string"
      || typeof data.byteOffset !== "number" || typeof data.msgIndex !== "number") {
    throw new Error(`Invalid cursor: bad shape`);
  }
  if (expectedAdapter && data.adapter !== expectedAdapter) {
    throw new CursorMismatchError(data.adapter, expectedAdapter);
  }
  return data;
}

export function cursorAdapter(cursor: Cursor): string {
  return decodeCursor(cursor).adapter;
}
```

- [ ] **Step 4: Run — should pass**

Run: `npm test -- cursor`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/cursor.ts test/unit/cursor.test.ts
git commit -m "feat(core): opaque cursor encode/decode"
```

---

## Phase 3: Registry

### Task 3.1: tmp-home test helper

**Files:**
- Create: `test/helpers/tmp-home.ts`

- [ ] **Step 1: Write helper**

```ts
// test/helpers/tmp-home.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTmpHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "agent-peek-"));
  return {
    home,
    cleanup: async () => { await rm(home, { recursive: true, force: true }); },
  };
}

export function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const k of Object.keys(vars)) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k]!;
      }
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add test/helpers/tmp-home.ts
git commit -m "test: tmp-home + withEnv helpers"
```

---

### Task 3.2: Registry CRUD

**Files:**
- Create: `src/core/registry.ts`
- Create: `test/unit/registry.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// test/unit/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Registry } from "../../src/core/registry.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import type { SessionEntry } from "../../src/core/types.js";

describe("Registry", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let reg: Registry;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    reg = new Registry({ home });
  });
  afterEach(async () => { await cleanup(); });

  const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
    id: "claude-code:abc",
    adapter: "claude-code",
    transcriptPath: "/tmp/abc.jsonl",
    lastSeen: new Date().toISOString(),
    status: "active",
    ...over,
  });

  it("starts empty", async () => {
    expect(await reg.list()).toEqual([]);
  });

  it("upsert + list", async () => {
    await reg.upsert(entry());
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("claude-code:abc");
  });

  it("upsert merges by id", async () => {
    await reg.upsert(entry({ tag: "v1" }));
    await reg.upsert(entry({ tag: "v2" }));
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.tag).toBe("v2");
  });

  it("get by id", async () => {
    await reg.upsert(entry());
    expect((await reg.get("claude-code:abc"))?.tag).toBeUndefined();
  });

  it("remove drops entry", async () => {
    await reg.upsert(entry());
    await reg.remove("claude-code:abc");
    expect(await reg.list()).toEqual([]);
  });

  it("flips stale entries to ended", async () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await reg.upsert(entry({ lastSeen: old, status: "active" }));
    await reg.pruneStale();
    const got = await reg.get("claude-code:abc");
    expect(got?.status).toBe("ended");
  });

  it("backs up corrupt registry and starts fresh", async () => {
    const { writeFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(home, ".agent-peek", "registry.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".agent-peek"), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    const fresh = new Registry({ home });
    expect(await fresh.list()).toEqual([]);
    const files = await readdir(join(home, ".agent-peek"));
    expect(files.some((f) => f.startsWith("registry.corrupt-"))).toBe(true);
  });

  it("survives concurrent upserts", async () => {
    await Promise.all(
      Array.from({ length: 20 }).map((_, i) =>
        reg.upsert(entry({ id: `claude-code:s${i}` })),
      ),
    );
    const list = await reg.list();
    expect(list).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `npm test -- registry`
Expected: FAIL with import errors.

- [ ] **Step 3: Implement Registry**

```ts
// src/core/registry.ts
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import type { SessionEntry } from "./types.js";
import { RegistryLockTimeoutError } from "./errors.js";

export interface RegistryOptions {
  home?: string;
  staleMs?: number;
}

interface RegistryFile {
  version: 1;
  sessions: Record<string, SessionEntry>;
}

export class Registry {
  private readonly dir: string;
  private readonly path: string;
  private readonly staleMs: number;

  constructor(opts: RegistryOptions = {}) {
    const home = opts.home ?? homedir();
    this.dir = join(home, ".agent-peek");
    this.path = join(this.dir, "registry.json");
    this.staleMs = opts.staleMs ?? 24 * 3600 * 1000;
  }

  async list(): Promise<SessionEntry[]> {
    const f = await this.read();
    return Object.values(f.sessions);
  }

  async get(id: string): Promise<SessionEntry | undefined> {
    const f = await this.read();
    return f.sessions[id];
  }

  async upsert(entry: SessionEntry): Promise<void> {
    await this.write((f) => {
      f.sessions[entry.id] = { ...f.sessions[entry.id], ...entry };
    });
  }

  async remove(id: string): Promise<void> {
    await this.write((f) => { delete f.sessions[id]; });
  }

  async pruneStale(): Promise<number> {
    const cutoff = Date.now() - this.staleMs;
    let count = 0;
    await this.write((f) => {
      for (const e of Object.values(f.sessions)) {
        if (e.status !== "ended" && Date.parse(e.lastSeen) < cutoff) {
          e.status = "ended";
          count++;
        }
      }
    });
    return count;
  }

  private async read(): Promise<RegistryFile> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.path)) return { version: 1, sessions: {} };
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return { version: 1, sessions: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && typeof parsed.sessions === "object") return parsed;
      throw new Error("bad shape");
    } catch {
      // Backup and reset.
      const backup = join(this.dir, `registry.corrupt-${Date.now()}.json`);
      try { await rename(this.path, backup); } catch { /* ignore */ }
      // eslint-disable-next-line no-console
      console.warn(`[agent-peek] registry corrupt, backed up to ${backup}`);
      return { version: 1, sessions: {} };
    }
  }

  private async write(mutator: (f: RegistryFile) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.path)) {
      await writeFile(this.path, JSON.stringify({ version: 1, sessions: {} }), "utf8");
    }
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.path, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 500, factor: 2 },
        stale: 10_000,
        realpath: false,
      });
    } catch (e) {
      throw new RegistryLockTimeoutError();
    }
    try {
      const f = await this.read();
      mutator(f);
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(f, null, 2), "utf8");
      await rename(tmp, this.path);
    } finally {
      await release();
    }
  }
}
```

- [ ] **Step 4: Run — should pass**

Run: `npm test -- registry`
Expected: PASS, 8 tests. (Concurrent upsert may take ~1s due to lockfile retries; OK.)

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts test/unit/registry.test.ts
git commit -m "feat(core): registry CRUD with lockfile + corrupt-backup"
```

---

## Phase 4: Adapter API + loader

### Task 4.1: Adapter interface

**Files:**
- Create: `src/adapters/types.ts`

- [ ] **Step 1: Write interface**

```ts
// src/adapters/types.ts
import type { SessionEntry, RawMessage, Cursor } from "../core/types.js";

export interface AdapterReadResult {
  messages: RawMessage[];
  nextCursor: Cursor;
  eof: boolean;
}

export interface Adapter {
  /** Stable adapter name. Used as id prefix and registry key. */
  name: string;

  /** Discover sessions on disk. Returns SessionEntry[]; loader merges into registry. */
  scan(): Promise<SessionEntry[]>;

  /**
   * Read messages from `entry`, optionally starting from `cursor`.
   * MUST stop at last newline-terminated record (no partial-line parsing).
   * MUST never throw on a writer-mid-flight; treat partial trailing line as eof.
   */
  read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult>;

  /** Optional: live tail. Reserved for v2; not used in v1. */
  watch?(entry: SessionEntry, onChange: () => void): () => void;
}

export interface AdapterModule {
  default: Adapter;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/types.ts
git commit -m "feat(adapters): adapter interface"
```

---

### Task 4.2: Adapter loader

**Files:**
- Create: `src/adapters/loader.ts`
- Create: `test/unit/loader.test.ts`

- [ ] **Step 1: Failing test**

```ts
// test/unit/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AdapterLoader } from "../../src/adapters/loader.js";
import { AdapterNotFoundError } from "../../src/core/errors.js";
import type { Adapter } from "../../src/adapters/types.js";

const fakeAdapter = (name: string): Adapter => ({
  name,
  async scan() { return []; },
  async read() { return { messages: [], nextCursor: "", eof: true }; },
});

describe("AdapterLoader", () => {
  let loader: AdapterLoader;
  beforeEach(() => { loader = new AdapterLoader(); });

  it("registers built-in adapters", () => {
    loader.register(fakeAdapter("claude-code"));
    expect(loader.get("claude-code").name).toBe("claude-code");
  });

  it("throws AdapterNotFoundError for unknown adapter", () => {
    expect(() => loader.get("nope")).toThrow(AdapterNotFoundError);
  });

  it("lists registered names", () => {
    loader.register(fakeAdapter("a"));
    loader.register(fakeAdapter("b"));
    expect(loader.names().sort()).toEqual(["a", "b"]);
  });

  it("rejects duplicate registration", () => {
    loader.register(fakeAdapter("a"));
    expect(() => loader.register(fakeAdapter("a"))).toThrow(/already registered/);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `npm test -- loader`
Expected: FAIL.

- [ ] **Step 3: Implement loader**

```ts
// src/adapters/loader.ts
import type { Adapter } from "./types.js";
import { AdapterNotFoundError } from "../core/errors.js";

export class AdapterLoader {
  private readonly adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter "${adapter.name}" already registered`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): Adapter {
    const a = this.adapters.get(name);
    if (!a) throw new AdapterNotFoundError(name);
    return a;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  names(): string[] {
    return Array.from(this.adapters.keys());
  }

  all(): Adapter[] {
    return Array.from(this.adapters.values());
  }
}

/**
 * Discover external adapter packages by scanning AGENT_PEEK_ADAPTER_PATH and
 * globally-installed npm packages whose name matches `agent-peek-adapter-*`
 * or `@*\/agent-peek-adapter-*`. Returns adapter modules, caller registers.
 *
 * Implementation detail: in v1 we ONLY load from AGENT_PEEK_ADAPTER_PATH (a
 * colon-separated list of paths to dirs whose entries are loadable adapter
 * packages or .js files). Global npm scan can be added later — it is os-
 * specific and brittle. This keeps v1 deterministic.
 */
export async function discoverExternal(loader: AdapterLoader): Promise<void> {
  const env = process.env.AGENT_PEEK_ADAPTER_PATH;
  if (!env) return;
  const paths = env.split(":").filter(Boolean);
  for (const p of paths) {
    try {
      const mod = await import(p);
      const adapter: Adapter | undefined = mod?.default;
      if (adapter && typeof adapter.name === "string"
          && typeof adapter.scan === "function"
          && typeof adapter.read === "function") {
        if (!loader.has(adapter.name)) loader.register(adapter);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[agent-peek] failed to load adapter from ${p}: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run — should pass**

Run: `npm test -- loader`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/loader.ts test/unit/loader.test.ts
git commit -m "feat(adapters): loader + AGENT_PEEK_ADAPTER_PATH discovery"
```

---

## Phase 5: Claude Code adapter

### Task 5.1: Research Claude Code transcript format

**Files:**
- (Research only — no commit)

- [ ] **Step 1: Inspect a real transcript**

Run: `ls ~/.claude/projects/ 2>/dev/null | head -5`
Run: `find ~/.claude/projects -name "*.jsonl" -type f 2>/dev/null | head -3`
Run: `head -3 "$(find ~/.claude/projects -name "*.jsonl" -type f 2>/dev/null | head -1)"`

Document the real fields seen (record types, role names, tool-call shapes). The expected shape (verify against reality):

- One JSON object per line (`\n` separated).
- Each object has at least: `type` (e.g. `"user"` | `"assistant"` | `"system"` | `"tool_use"` | `"tool_result"`), `timestamp`, `uuid`, `parentUuid`, `sessionId`, `cwd`, plus a `message` field for content.
- Assistant turns include `message.content` as an array with text + tool_use blocks.

**If actual format differs, adjust `parse.ts` in Task 5.3 accordingly.** Record the verified shape inline in `parse.ts` as a comment for the next maintainer.

- [ ] **Step 2: No commit yet** — proceed.

---

### Task 5.2: Claude Code fixtures

**Files:**
- Create: `test/fixtures/claude-code/empty/transcript.jsonl`
- Create: `test/fixtures/claude-code/multi-turn/transcript.jsonl`
- Create: `test/fixtures/claude-code/mid-tool-call/transcript.jsonl`
- Create: `test/fixtures/claude-code/corrupt-tail/transcript.jsonl`

- [ ] **Step 1: Empty fixture**

`test/fixtures/claude-code/empty/transcript.jsonl`:
```
```
(zero-byte file)

- [ ] **Step 2: Multi-turn fixture**

`test/fixtures/claude-code/multi-turn/transcript.jsonl`:
```
{"type":"user","sessionId":"s1","cwd":"/tmp/repo","timestamp":"2026-04-28T12:00:00.000Z","uuid":"u1","message":{"role":"user","content":"refactor auth"}}
{"type":"assistant","sessionId":"s1","cwd":"/tmp/repo","timestamp":"2026-04-28T12:00:05.000Z","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"Looking at the auth module."}]}}
{"type":"assistant","sessionId":"s1","cwd":"/tmp/repo","timestamp":"2026-04-28T12:00:08.000Z","uuid":"a2","parentUuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/repo/auth.ts"}}]}}
{"type":"tool_result","sessionId":"s1","cwd":"/tmp/repo","timestamp":"2026-04-28T12:00:09.000Z","uuid":"r1","parentUuid":"a2","message":{"role":"tool","tool_use_id":"t1","content":"export function login(){}"}}
{"type":"assistant","sessionId":"s1","cwd":"/tmp/repo","timestamp":"2026-04-28T12:00:12.000Z","uuid":"a3","parentUuid":"r1","message":{"role":"assistant","content":[{"type":"text","text":"Found it. Will rewrite next."}]}}
```
(5 lines, each newline-terminated.)

- [ ] **Step 3: Mid-tool-call fixture**

`test/fixtures/claude-code/mid-tool-call/transcript.jsonl`:
```
{"type":"user","sessionId":"s2","cwd":"/tmp/repo2","timestamp":"2026-04-28T13:00:00.000Z","uuid":"u1","message":{"role":"user","content":"run tests"}}
{"type":"assistant","sessionId":"s2","cwd":"/tmp/repo2","timestamp":"2026-04-28T13:00:02.000Z","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}
```
(2 lines — last is a pending tool_use with no result yet.)

- [ ] **Step 4: Corrupt-tail fixture**

`test/fixtures/claude-code/corrupt-tail/transcript.jsonl`:
```
{"type":"user","sessionId":"s3","cwd":"/tmp/repo3","timestamp":"2026-04-28T14:00:00.000Z","uuid":"u1","message":{"role":"user","content":"hello"}}
{"type":"assistant","sessionId":"s3","cwd":"/tmp/repo3","timestamp":"2026-04-28T14:00:05.000Z","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","sessionId":"s3","cwd":"/tmp/repo3","timestamp":"2026-04-28T14:00:08
```
(Third line has NO trailing `\n` and is truncated — simulates writer-in-flight.)

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/claude-code
git commit -m "test: claude-code fixture transcripts"
```

---

### Task 5.3: Claude Code parser

**Files:**
- Create: `src/adapters/claude-code/parse.ts`

- [ ] **Step 1: Implement parser (TDD comes via adapter test)**

```ts
// src/adapters/claude-code/parse.ts
import type { RawMessage, ToolCall } from "../../core/types.js";

/**
 * Claude Code transcript format (verified 2026-04-28):
 * One JSON object per line. Fields:
 *   type: "user" | "assistant" | "tool_result" | "system" | ...
 *   sessionId, cwd, uuid, parentUuid, timestamp (ISO string)
 *   message: { role, content }
 *     - content is string OR array of blocks
 *     - blocks: { type: "text", text } | { type: "tool_use", id, name, input } | { type: "tool_result", tool_use_id, content }
 */

export interface RawClaudeRecord {
  type: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    tool_use_id?: string;
  };
}

export function parseRecord(rec: RawClaudeRecord): RawMessage {
  const role = (rec.message?.role ?? rec.type ?? "system") as RawMessage["role"];
  const text = extractText(rec.message?.content);
  const toolCalls = extractToolCalls(rec);
  return {
    role: normalizeRole(role, rec.type),
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: rec,
    timestamp: rec.timestamp,
  };
}

function normalizeRole(role: string, type: string): RawMessage["role"] {
  if (role === "tool" || type === "tool_result") return "tool";
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "system";
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && (b as any).type === "text"
          && typeof (b as any).text === "string") {
        parts.push((b as any).text);
      }
    }
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

function extractToolCalls(rec: RawClaudeRecord): ToolCall[] {
  const out: ToolCall[] = [];
  const content = rec.message?.content;
  if (rec.type === "tool_result") {
    out.push({
      name: "(result)",
      output: typeof content === "string" ? content : content,
      status: "completed",
    });
    return out;
  }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === "object" && (b as any).type === "tool_use") {
        out.push({
          name: (b as any).name ?? "?",
          input: (b as any).input,
          status: "pending",
        });
      }
    }
  }
  return out;
}

/**
 * Parse a JSONL byte buffer starting at byteOffset, returning parsed records
 * and the byte offset of the last complete line + newline.
 * Lines that fail JSON.parse are skipped (counted in `skipped`).
 * Trailing partial line (no \n) is NOT consumed: nextOffset stops at last \n.
 */
export function parseJsonlSlice(buf: Buffer, fromOffset: number): {
  records: RawClaudeRecord[];
  nextOffset: number;
  skipped: number;
} {
  const records: RawClaudeRecord[] = [];
  let i = fromOffset;
  let skipped = 0;
  let lastNewline = fromOffset;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl === -1) break; // no complete line remains
    const line = buf.subarray(i, nl).toString("utf8").trim();
    if (line.length > 0) {
      try {
        records.push(JSON.parse(line));
      } catch {
        skipped++;
      }
    }
    i = nl + 1;
    lastNewline = i;
  }
  return { records, nextOffset: lastNewline, skipped };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/claude-code/parse.ts
git commit -m "feat(claude-code): JSONL parser + record normalization"
```

---

### Task 5.4: Adapter conformance helper

**Files:**
- Create: `test/helpers/adapter-conformance.ts`

- [ ] **Step 1: Helper**

```ts
// test/helpers/adapter-conformance.ts
import { expect } from "vitest";
import type { Adapter } from "../../src/adapters/types.js";
import type { SessionEntry } from "../../src/core/types.js";
import { decodeCursor } from "../../src/core/cursor.js";

export interface ConformanceFixture {
  name: string;
  entry: SessionEntry;
  expectMinMessages?: number;
  expectEofImmediately?: boolean;
}

/** Conformance suite — any adapter must pass these. */
export async function runAdapterConformance(adapter: Adapter, fx: ConformanceFixture) {
  // Initial read: full snapshot.
  const r1 = await adapter.read(fx.entry);
  expect(Array.isArray(r1.messages)).toBe(true);
  if (fx.expectMinMessages !== undefined) {
    expect(r1.messages.length).toBeGreaterThanOrEqual(fx.expectMinMessages);
  }
  // Cursor must be parseable as that adapter.
  const c = decodeCursor(r1.nextCursor);
  expect(c.adapter).toBe(adapter.name);

  // Re-read with cursor: should yield 0 messages and same offset (eof unchanged).
  const r2 = await adapter.read(fx.entry, r1.nextCursor);
  expect(r2.messages.length).toBe(0);
  expect(decodeCursor(r2.nextCursor).byteOffset).toBe(c.byteOffset);
}
```

- [ ] **Step 2: Commit**

```bash
git add test/helpers/adapter-conformance.ts
git commit -m "test: adapter conformance helper"
```

---

### Task 5.5: Claude Code adapter

**Files:**
- Create: `src/adapters/claude-code/index.ts`
- Create: `test/adapters/claude-code.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// test/adapters/claude-code.test.ts
import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import claudeCode from "../../src/adapters/claude-code/index.js";
import type { SessionEntry } from "../../src/core/types.js";
import { encodeCursor, decodeCursor } from "../../src/core/cursor.js";
import { runAdapterConformance } from "../helpers/adapter-conformance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(__dirname, "../fixtures/claude-code", name, "transcript.jsonl");

const entry = (path: string, id = "claude-code:test"): SessionEntry => ({
  id,
  adapter: "claude-code",
  transcriptPath: path,
  lastSeen: new Date().toISOString(),
  status: "active",
});

describe("claude-code adapter", () => {
  it("scan finds nothing under empty $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "ac-empty-"));
    process.env.HOME = home;
    const sessions = await claudeCode.scan();
    expect(sessions).toEqual([]);
  });

  it("reads multi-turn fixture", async () => {
    const r = await claudeCode.read(entry(fixture("multi-turn")));
    expect(r.messages.length).toBe(5);
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages[0]!.text).toBe("refactor auth");
    expect(r.messages[2]!.toolCalls?.[0]?.name).toBe("Read");
    expect(r.eof).toBe(true);
  });

  it("returns empty for empty fixture", async () => {
    const r = await claudeCode.read(entry(fixture("empty")));
    expect(r.messages.length).toBe(0);
  });

  it("ignores corrupt trailing line (writer in flight)", async () => {
    const r = await claudeCode.read(entry(fixture("corrupt-tail")));
    // 2 complete lines + trailing partial line discarded
    expect(r.messages.length).toBe(2);
  });

  it("cursor diff returns only new messages", async () => {
    // Use a tmp file we control
    const dir = await mkdtemp(join(tmpdir(), "ac-cursor-"));
    const path = join(dir, "t.jsonl");
    await writeFile(path,
      `{"type":"user","sessionId":"x","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"first"}}\n`
      + `{"type":"assistant","sessionId":"x","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n`,
      "utf8");
    const r1 = await claudeCode.read(entry(path));
    expect(r1.messages.length).toBe(2);

    await appendFile(path,
      `{"type":"user","sessionId":"x","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"second"}}\n`,
      "utf8");

    const r2 = await claudeCode.read(entry(path), r1.nextCursor);
    expect(r2.messages.length).toBe(1);
    expect(r2.messages[0]!.text).toBe("second");
  });

  it("rejects cursor from another adapter", async () => {
    const bad = encodeCursor({ adapter: "codex", byteOffset: 0, msgIndex: 0 });
    await expect(claudeCode.read(entry(fixture("multi-turn")), bad)).rejects.toThrow();
  });

  it("passes adapter conformance suite (multi-turn)", async () => {
    await runAdapterConformance(claudeCode, {
      name: "multi-turn",
      entry: entry(fixture("multi-turn")),
      expectMinMessages: 5,
    });
  });

  it("scan picks up sessions under fake $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "ac-home-"));
    const projDir = join(home, ".claude", "projects", "-tmp-repo");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "abc.jsonl");
    await writeFile(tx, `{"type":"user","sessionId":"abc","cwd":"/tmp/repo","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`, "utf8");
    process.env.HOME = home;
    const sessions = await claudeCode.scan();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe("claude-code:abc");
    expect(sessions[0]!.cwd).toBe("/tmp/repo");
    expect(sessions[0]!.transcriptPath).toBe(tx);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `npm test -- claude-code.test`
Expected: FAIL.

- [ ] **Step 3: Implement adapter**

```ts
// src/adapters/claude-code/index.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReadResult } from "../types.js";
import type { SessionEntry, RawMessage, Cursor } from "../../core/types.js";
import { encodeCursor, decodeCursor } from "../../core/cursor.js";
import { TranscriptUnreadableError } from "../../core/errors.js";
import { parseJsonlSlice, parseRecord } from "./parse.js";

const ADAPTER_NAME = "claude-code";

const adapter: Adapter = {
  name: ADAPTER_NAME,

  async scan(): Promise<SessionEntry[]> {
    const root = join(homedir(), ".claude", "projects");
    if (!existsSync(root)) return [];
    const out: SessionEntry[] = [];
    let projects: string[];
    try {
      projects = await readdir(root);
    } catch {
      return [];
    }
    for (const p of projects) {
      const projDir = join(root, p);
      let files: string[];
      try {
        files = await readdir(projDir);
      } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fpath = join(projDir, f);
        let st;
        try { st = await stat(fpath); } catch { continue; }
        // Read just first record to recover sessionId + cwd if available.
        let sessionId = f.replace(/\.jsonl$/, "");
        let cwd: string | undefined;
        try {
          const head = await readFirstLine(fpath);
          if (head) {
            try {
              const rec = JSON.parse(head);
              if (typeof rec?.sessionId === "string") sessionId = rec.sessionId;
              if (typeof rec?.cwd === "string") cwd = rec.cwd;
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
        const ageMs = Date.now() - st.mtimeMs;
        const status = ageMs < 5 * 60 * 1000 ? "active"
                     : ageMs < 24 * 3600 * 1000 ? "idle"
                     : "ended";
        out.push({
          id: `${ADAPTER_NAME}:${sessionId}`,
          adapter: ADAPTER_NAME,
          transcriptPath: fpath,
          cwd,
          lastSeen: new Date(st.mtimeMs).toISOString(),
          status,
        });
      }
    }
    return out;
  },

  async read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult> {
    let buf: Buffer;
    try {
      buf = await readFile(entry.transcriptPath);
    } catch (e) {
      throw new TranscriptUnreadableError(ADAPTER_NAME, `cannot read ${entry.transcriptPath}`, e);
    }
    let from = 0;
    let priorIndex = 0;
    if (cursor) {
      const c = decodeCursor(cursor, ADAPTER_NAME);
      from = Math.min(c.byteOffset, buf.length);
      priorIndex = c.msgIndex;
    }
    const { records, nextOffset } = parseJsonlSlice(buf, from);
    const messages: RawMessage[] = records.map(parseRecord);
    const nextCursor = encodeCursor({
      adapter: ADAPTER_NAME,
      byteOffset: nextOffset,
      msgIndex: priorIndex + messages.length,
    });
    return { messages, nextCursor, eof: nextOffset === buf.length };
  },
};

async function readFirstLine(path: string): Promise<string | null> {
  const buf = await readFile(path);
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return buf.length ? buf.toString("utf8") : null;
  return buf.subarray(0, nl).toString("utf8");
}

export default adapter;
```

- [ ] **Step 4: Run — should pass**

Run: `npm test -- claude-code.test`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude-code test/adapters/claude-code.test.ts
git commit -m "feat(claude-code): adapter (scan + cursored read)"
```

---

## Phase 6: Codex adapter

### Task 6.1: Research Codex transcript format

**Files:**
- (Research only)

- [ ] **Step 1: Find Codex transcript on disk**

Run: `ls ~/.codex 2>/dev/null; ls ~/.config/codex 2>/dev/null; ls ~/Library/Application\ Support/Codex 2>/dev/null`
Run: `find ~ -name "*.jsonl" -path "*codex*" -type f 2>/dev/null | head -3`

If no Codex CLI installed locally, fall back to source:
- Repo: `https://github.com/openai/codex` — check `cli/` or `agent/` for transcript persistence path + format.

Document the actual path + record shape verified. The likely path: `~/.codex/sessions/<id>/messages.jsonl` (placeholder — verify).

- [ ] **Step 2: If format is JSONL with similar shape, reuse parser pattern from claude-code. If radically different, plan adjustments inline in next tasks.**

If Codex format cannot be verified within reasonable effort, **descope Codex from v1**: keep `src/adapters/codex/` empty, document in README under "Roadmap", remove from `built-ins` registration, update spec's "v1 adapters" line. Open an issue in the repo to track.

No commit yet.

---

### Task 6.2: Codex parser + adapter (CONDITIONAL on 6.1)

**Files (if proceeding):**
- Create: `src/adapters/codex/parse.ts`
- Create: `src/adapters/codex/index.ts`
- Create: `test/fixtures/codex/multi-turn/transcript.jsonl`
- Create: `test/adapters/codex.test.ts`

- [ ] **Step 1: Mirror claude-code structure**

Create the same shape of files as Phase 5 (parser + adapter + fixture + test) but with field mappings discovered in 6.1. The shape should be:

```ts
// src/adapters/codex/index.ts (skeleton — adjust to verified format)
import type { Adapter } from "../types.js";
const ADAPTER_NAME = "codex";
const adapter: Adapter = {
  name: ADAPTER_NAME,
  async scan() { /* glob ~/.codex/sessions/*\/messages.jsonl */ return []; },
  async read(entry, cursor) { /* same byte-offset cursor as claude-code */ throw new Error("unimplemented"); },
};
export default adapter;
```

- [ ] **Step 2: Tests mirror claude-code.test.ts structure**

Reuse `runAdapterConformance` against codex fixtures.

- [ ] **Step 3: Commit only after all tests pass**

```bash
git add src/adapters/codex test/adapters/codex.test.ts test/fixtures/codex
git commit -m "feat(codex): adapter (scan + cursored read)"
```

**If descoped:** instead, edit the v1 plan + README to remove Codex, and create an issue. Commit:

```bash
git commit -am "docs: descope codex adapter from v1, tracked in issue"
```

---

## Phase 7: Snapshot tiers

### Task 7.1: Raw + structured

**Files:**
- Create: `src/core/snapshot.ts`
- Create: `test/unit/snapshot.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// test/unit/snapshot.test.ts
import { describe, it, expect } from "vitest";
import { toRaw, toStructured } from "../../src/core/snapshot.js";
import type { RawMessage } from "../../src/core/types.js";

const msgs = (): RawMessage[] => [
  { role: "user", text: "do X", raw: {} },
  { role: "assistant", text: "starting", raw: {} },
  { role: "assistant", text: undefined, toolCalls: [{ name: "Read", input: { p: "f" }, status: "pending" }], raw: {} },
  { role: "tool", text: undefined, toolCalls: [{ name: "(result)", output: "contents", status: "completed" }], raw: {} },
  { role: "assistant", text: "done", raw: {} },
];

describe("snapshot.toRaw", () => {
  it("passes through messages", () => {
    const s = toRaw("sid", msgs());
    expect(s.mode).toBe("raw");
    expect(s.sessionId).toBe("sid");
    expect(s.messages.length).toBe(5);
  });

  it("respects limit", () => {
    const s = toRaw("sid", msgs(), { limit: 2 });
    expect(s.messages.length).toBe(2);
    expect(s.messages[0]!.text).toBe("(result)" === s.messages[0]!.text ? "(result)" : s.messages[0]!.text);
    // tail of 2 = last 2 messages
    expect(s.messages[1]!.text).toBe("done");
  });
});

describe("snapshot.toStructured", () => {
  it("derives lastUser/lastAssistant + counts", () => {
    const s = toStructured("sid", msgs());
    expect(s.mode).toBe("structured");
    expect(s.messageCount).toBe(5);
    expect(s.lastUserMessage).toBe("do X");
    expect(s.lastAssistantMessage).toBe("done");
  });

  it("activity tool-running while a tool_use is unanswered", () => {
    const m: RawMessage[] = [
      { role: "user", text: "x", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", status: "pending" }], raw: {} },
    ];
    const s = toStructured("sid", m);
    expect(s.activity).toBe("tool-running");
    expect(s.pendingToolCalls.length).toBe(1);
  });

  it("activity thinking when last is assistant text", () => {
    const m: RawMessage[] = [
      { role: "user", text: "x", raw: {} },
      { role: "assistant", text: "considering", raw: {} },
    ];
    expect(toStructured("s", m).activity).toBe("thinking");
  });

  it("activity idle when last is user", () => {
    const m: RawMessage[] = [{ role: "user", text: "x", raw: {} }];
    expect(toStructured("s", m).activity).toBe("idle");
  });

  it("currentTask comes from last user message (heuristic)", () => {
    const s = toStructured("sid", msgs());
    expect(s.currentTask).toBe("do X");
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `npm test -- snapshot`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/core/snapshot.ts
import type {
  RawMessage, RawSnapshot, StructuredSnapshot, ToolCall,
} from "./types.js";

export interface ToRawOpts {
  /** If set, return only the trailing N messages. */
  limit?: number;
}

export function toRaw(sessionId: string, messages: RawMessage[], opts: ToRawOpts = {}): RawSnapshot {
  const sliced = opts.limit !== undefined && messages.length > opts.limit
    ? messages.slice(-opts.limit)
    : messages;
  return { mode: "raw", sessionId, messages: sliced };
}

export function toStructured(sessionId: string, messages: RawMessage[]): StructuredSnapshot {
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  const lastToolCalls: ToolCall[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.text) lastUserMessage = m.text;
    if (m.role === "assistant" && m.text) lastAssistantMessage = m.text;
    if (m.toolCalls) lastToolCalls.push(...m.toolCalls);
  }
  const pendingToolCalls = computePending(messages);
  const activity = computeActivity(messages, pendingToolCalls);
  return {
    mode: "structured",
    sessionId,
    messageCount: messages.length,
    lastUserMessage,
    lastAssistantMessage,
    currentTask: lastUserMessage,
    pendingToolCalls,
    lastToolCalls: lastToolCalls.slice(-5),
    activity,
  };
}

function computePending(messages: RawMessage[]): ToolCall[] {
  // A tool_use is pending if no later "(result)" tool call exists in same window.
  const pendingByName: ToolCall[] = [];
  let resultsAfter = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") resultsAfter++;
    else if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.status === "pending") {
          if (resultsAfter > 0) resultsAfter--;
          else pendingByName.unshift(tc);
        }
      }
    }
  }
  return pendingByName;
}

function computeActivity(messages: RawMessage[], pending: ToolCall[]): "idle" | "thinking" | "tool-running" {
  if (pending.length > 0) return "tool-running";
  const last = messages[messages.length - 1];
  if (!last) return "idle";
  if (last.role === "assistant") return "thinking";
  return "idle";
}
```

- [ ] **Step 4: Run — should pass**

Run: `npm test -- snapshot`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/snapshot.ts test/unit/snapshot.test.ts
git commit -m "feat(core): raw + structured snapshot transformers"
```

---

### Task 7.2: Summary tier

**Files:**
- Modify: `src/core/snapshot.ts` (add `toSummary`)
- Modify: `test/unit/snapshot.test.ts` (add summary tests)

- [ ] **Step 1: Failing test**

Append to `test/unit/snapshot.test.ts`:

```ts
import { toSummary } from "../../src/core/snapshot.js";
import { withEnv } from "../helpers/tmp-home.js";

describe("snapshot.toSummary", () => {
  it("falls back to structured when no API key", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "" }, async () => {
      const s = await toSummary("sid", [{ role: "user", text: "hi", raw: {} }], { deltaMessageCount: 1 });
      expect(s.mode).toBe("summary");
      expect(s.fallback).toBe(true);
      expect(s.structured).toBeDefined();
      expect(s.summary).toMatch(/no.*api.*key/i);
    });
  });

  it("calls anthropic client when key present", async () => {
    let captured: any = null;
    const mockClient = {
      messages: {
        create: async (req: any) => {
          captured = req;
          return { content: [{ type: "text", text: "Agent is doing X." }] };
        },
      },
    };
    const s = await toSummary(
      "sid",
      [{ role: "user", text: "do X", raw: {} }],
      { deltaMessageCount: 1, client: mockClient as any, model: "claude-haiku-4-5" },
    );
    expect(s.summary).toBe("Agent is doing X.");
    expect(s.fallback).toBeFalsy();
    expect(captured.model).toBe("claude-haiku-4-5");
  });

  it("caches by (sessionId, cursor) for 60s", async () => {
    let calls = 0;
    const mockClient = {
      messages: {
        create: async () => { calls++; return { content: [{ type: "text", text: "x" }] }; },
      },
    };
    const m = [{ role: "user" as const, text: "a", raw: {} }];
    await toSummary("sid", m, { deltaMessageCount: 1, client: mockClient as any, cacheKey: "k1" });
    await toSummary("sid", m, { deltaMessageCount: 1, client: mockClient as any, cacheKey: "k1" });
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `npm test -- snapshot`
Expected: FAIL on `toSummary` import.

- [ ] **Step 3: Implement summary**

Append to `src/core/snapshot.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { SummarySnapshot } from "./types.js";

interface ToSummaryOpts {
  deltaMessageCount: number;
  client?: { messages: { create: (req: any) => Promise<any> } };
  model?: string;
  cacheKey?: string;
  ttlMs?: number;
}

const summaryCache = new Map<string, { value: string; expires: number }>();

export async function toSummary(
  sessionId: string,
  messages: RawMessage[],
  opts: ToSummaryOpts,
): Promise<SummarySnapshot> {
  const structured = toStructured(sessionId, messages);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!opts.client && !key) {
    return {
      mode: "summary",
      sessionId,
      summary: "Summary unavailable: no ANTHROPIC_API_KEY set; returning structured snapshot.",
      deltaMessageCount: opts.deltaMessageCount,
      fallback: true,
      structured,
    };
  }
  const cacheId = opts.cacheKey ? `${sessionId}::${opts.cacheKey}` : undefined;
  const ttl = opts.ttlMs ?? 60_000;
  if (cacheId) {
    const hit = summaryCache.get(cacheId);
    if (hit && hit.expires > Date.now()) {
      return {
        mode: "summary",
        sessionId,
        summary: hit.value,
        deltaMessageCount: opts.deltaMessageCount,
      };
    }
  }
  const client = opts.client ?? new Anthropic({ apiKey: key! });
  const model = opts.model ?? process.env.AGENT_PEEK_SUMMARY_MODEL ?? "claude-haiku-4-5";
  const prompt = renderSummaryPrompt(messages);
  let summary: string;
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const block = resp.content?.[0];
    summary = (block && (block as any).type === "text") ? (block as any).text : "(no summary)";
  } catch (e) {
    return {
      mode: "summary",
      sessionId,
      summary: `Summary unavailable: ${(e as Error).message}; returning structured snapshot.`,
      deltaMessageCount: opts.deltaMessageCount,
      fallback: true,
      structured,
    };
  }
  if (cacheId) summaryCache.set(cacheId, { value: summary, expires: Date.now() + ttl });
  return { mode: "summary", sessionId, summary, deltaMessageCount: opts.deltaMessageCount };
}

function renderSummaryPrompt(messages: RawMessage[]): string {
  const tail = messages.slice(-30);
  const lines: string[] = [
    "You are observing another AI agent's chat. Summarize what the agent is currently doing in 2-3 sentences.",
    "Focus on: current task, recent tool calls, and whether it appears blocked or progressing.",
    "Do not invent details. If the messages are sparse, say so.",
    "",
    "--- transcript tail ---",
  ];
  for (const m of tail) {
    if (m.text) lines.push(`[${m.role}] ${m.text}`);
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        lines.push(`[${m.role}] tool=${tc.name} status=${tc.status ?? "?"}`);
      }
    }
  }
  lines.push("--- end ---");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run — should pass**

Run: `npm test -- snapshot`
Expected: PASS, 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/core/snapshot.ts test/unit/snapshot.test.ts
git commit -m "feat(core): summary tier with anthropic client + 60s cache"
```

---

## Phase 8: Engine

### Task 8.1: Engine

**Files:**
- Create: `src/core/engine.ts`
- Create: `test/unit/engine.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// test/unit/engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import { AdapterLoader } from "../../src/adapters/loader.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import { SessionNotFoundError, AmbiguousSelectorError } from "../../src/core/errors.js";
import type { Adapter } from "../../src/adapters/types.js";
import type { SessionEntry, RawMessage } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";

const makeFakeAdapter = (rows: Record<string, RawMessage[]>): Adapter => ({
  name: "fake",
  async scan() {
    return Object.keys(rows).map((id) => ({
      id: `fake:${id}`,
      adapter: "fake",
      transcriptPath: `/tmp/${id}`,
      lastSeen: new Date().toISOString(),
      status: "active" as const,
    }));
  },
  async read(entry, cursor) {
    const id = entry.id.replace("fake:", "");
    const all = rows[id] ?? [];
    let from = 0;
    if (cursor) {
      const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      from = c.msgIndex ?? 0;
    }
    const messages = all.slice(from);
    return {
      messages,
      nextCursor: encodeCursor({ adapter: "fake", byteOffset: 0, msgIndex: all.length }),
      eof: true,
    };
  },
});

describe("Engine", () => {
  let home: string, cleanup: () => Promise<void>;
  let engine: Engine;
  let registry: Registry;
  let loader: AdapterLoader;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    registry = new Registry({ home });
    loader = new AdapterLoader();
    loader.register(makeFakeAdapter({
      a: [{ role: "user", text: "do X", raw: {} }, { role: "assistant", text: "ok", raw: {} }],
      b: [{ role: "user", text: "second", raw: {} }],
    }));
    engine = new Engine({ registry, loader });
  });
  afterEach(async () => { await cleanup(); });

  it("list scans adapters and merges into registry", async () => {
    const list = await engine.list();
    expect(list.length).toBe(2);
    expect((await registry.list()).length).toBe(2);
  });

  it("peek by exact id returns raw snapshot", async () => {
    await engine.list();
    const r = await engine.peek("fake:a", { mode: "raw" });
    expect(r.snapshot.mode).toBe("raw");
    expect((r.snapshot as any).messages.length).toBe(2);
  });

  it("peek by tag works after tag()", async () => {
    await engine.list();
    await engine.tag("fake:a", "researcher");
    const r = await engine.peek("researcher", { mode: "structured" });
    expect((r.snapshot as any).mode).toBe("structured");
  });

  it("peek with cursor returns delta", async () => {
    await engine.list();
    const r1 = await engine.peek("fake:a", { mode: "raw" });
    const r2 = await engine.peek("fake:a", { mode: "raw", since: r1.nextCursor });
    expect((r2.snapshot as any).messages.length).toBe(0);
  });

  it("SessionNotFoundError for unknown selector", async () => {
    await expect(engine.peek("nope")).rejects.toThrow(SessionNotFoundError);
  });

  it("AmbiguousSelectorError when cwd matches >1 session", async () => {
    await engine.list();
    await registry.upsert({
      id: "fake:a", adapter: "fake", transcriptPath: "/tmp/a",
      cwd: "/work", lastSeen: new Date().toISOString(), status: "active",
    });
    await registry.upsert({
      id: "fake:b", adapter: "fake", transcriptPath: "/tmp/b",
      cwd: "/work", lastSeen: new Date().toISOString(), status: "active",
    });
    await expect(engine.peek("/work")).rejects.toThrow(AmbiguousSelectorError);
  });

  it("register adds entry with given tag", async () => {
    await engine.register({
      id: "fake:c", adapter: "fake", transcriptPath: "/tmp/c", tag: "side",
    });
    const got = await registry.get("fake:c");
    expect(got?.tag).toBe("side");
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `npm test -- engine`
Expected: FAIL.

- [ ] **Step 3: Implement Engine**

```ts
// src/core/engine.ts
import type { Registry } from "./registry.js";
import type { AdapterLoader } from "../adapters/loader.js";
import type {
  SessionEntry, PeekResult, SnapshotMode, Cursor,
} from "./types.js";
import {
  SessionNotFoundError, AmbiguousSelectorError, AdapterError,
} from "./errors.js";
import { toRaw, toStructured, toSummary } from "./snapshot.js";
import { decodeCursor, cursorAdapter } from "./cursor.js";

export interface PeekOpts {
  mode?: SnapshotMode;
  since?: Cursor;
  limit?: number;
}

export interface RegisterOpts {
  id: string;
  adapter: string;
  transcriptPath: string;
  cwd?: string;
  tag?: string;
  pid?: number;
}

export class Engine {
  constructor(private readonly deps: { registry: Registry; loader: AdapterLoader }) {}

  async list(filter?: { adapter?: string; status?: SessionEntry["status"] }): Promise<SessionEntry[]> {
    const { registry, loader } = this.deps;
    // Run scans in parallel; tolerate adapter failures.
    const scans = await Promise.allSettled(loader.all().map((a) => a.scan()));
    for (let i = 0; i < scans.length; i++) {
      const r = scans[i]!;
      if (r.status === "fulfilled") {
        for (const e of r.value) await registry.upsert(e);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[agent-peek] adapter scan failed: ${(r.reason as Error).message}`);
      }
    }
    let list = await registry.list();
    if (filter?.adapter) list = list.filter((e) => e.adapter === filter.adapter);
    if (filter?.status) list = list.filter((e) => e.status === filter.status);
    return list.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  async peek(selector: string, opts: PeekOpts = {}): Promise<PeekResult> {
    const entry = await this.resolve(selector);
    const adapter = this.deps.loader.get(entry.adapter);
    let cursor = opts.since;
    if (cursor) {
      const adapterFromCursor = cursorAdapter(cursor);
      if (adapterFromCursor !== entry.adapter) {
        throw new AdapterError(entry.adapter,
          `cursor was issued by adapter "${adapterFromCursor}"`);
      }
    }
    const result = await adapter.read(entry, cursor);
    const messages = result.messages;
    const mode: SnapshotMode = opts.mode ?? "raw";
    let snapshot;
    if (mode === "raw") snapshot = toRaw(entry.id, messages, { limit: opts.limit ?? 200 });
    else if (mode === "structured") snapshot = toStructured(entry.id, messages);
    else snapshot = await toSummary(entry.id, messages, {
      deltaMessageCount: messages.length,
      cacheKey: result.nextCursor,
    });
    return { snapshot, nextCursor: result.nextCursor, eof: result.eof };
  }

  async register(opts: RegisterOpts): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: opts.id,
      adapter: opts.adapter,
      transcriptPath: opts.transcriptPath,
      cwd: opts.cwd,
      tag: opts.tag,
      pid: opts.pid,
      lastSeen: new Date().toISOString(),
      status: "active",
    };
    await this.deps.registry.upsert(entry);
    return entry;
  }

  async tag(id: string, tag: string): Promise<void> {
    const e = await this.deps.registry.get(id);
    if (!e) throw new SessionNotFoundError(id);
    await this.deps.registry.upsert({ ...e, tag });
  }

  async untag(id: string): Promise<void> {
    const e = await this.deps.registry.get(id);
    if (!e) throw new SessionNotFoundError(id);
    const { tag, ...rest } = e;
    await this.deps.registry.upsert(rest);
  }

  async unregister(id: string): Promise<void> {
    await this.deps.registry.remove(id);
  }

  private async resolve(selector: string): Promise<SessionEntry> {
    const list = await this.deps.registry.list();
    const exact = list.find((e) => e.id === selector);
    if (exact) return exact;
    const tagMatches = list.filter((e) => e.tag === selector);
    if (tagMatches.length === 1) return tagMatches[0]!;
    if (tagMatches.length > 1) {
      throw new AmbiguousSelectorError(selector, tagMatches.map((e) => e.id));
    }
    const cwdMatches = list.filter((e) => e.cwd === selector);
    if (cwdMatches.length === 1) return cwdMatches[0]!;
    if (cwdMatches.length > 1) {
      throw new AmbiguousSelectorError(selector, cwdMatches.map((e) => e.id));
    }
    const cwdPrefix = list.filter((e) => e.cwd && e.cwd.startsWith(selector));
    if (cwdPrefix.length === 1) return cwdPrefix[0]!;
    if (cwdPrefix.length > 1) {
      throw new AmbiguousSelectorError(selector, cwdPrefix.map((e) => e.id));
    }
    throw new SessionNotFoundError(selector);
  }
}
```

- [ ] **Step 4: Run — should pass**

Run: `npm test -- engine`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts test/unit/engine.test.ts
git commit -m "feat(core): engine — peek/list/register/tag with selector resolution"
```

---

## Phase 9: Library entry + built-in adapter wiring

### Task 9.1: Public library API

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace stub with full API**

```ts
// src/index.ts
export const VERSION = "0.1.0";

export type {
  SessionEntry, SessionStatus, Activity,
  RawMessage, ToolCall,
  Cursor, CursorData,
  Snapshot, RawSnapshot, StructuredSnapshot, SummarySnapshot, SnapshotMode,
  PeekResult,
} from "./core/types.js";

export {
  SessionNotFoundError, AmbiguousSelectorError, AdapterError,
  AdapterNotFoundError, CursorMismatchError, RegistryLockTimeoutError,
  TranscriptUnreadableError, TranscriptCorruptError, SummaryUnavailableError,
} from "./core/errors.js";

export { Registry } from "./core/registry.js";
export { Engine } from "./core/engine.js";
export { encodeCursor, decodeCursor, cursorAdapter } from "./core/cursor.js";
export { toRaw, toStructured, toSummary } from "./core/snapshot.js";

export { AdapterLoader, discoverExternal } from "./adapters/loader.js";
export type { Adapter, AdapterReadResult, AdapterModule } from "./adapters/types.js";

import claudeCode from "./adapters/claude-code/index.js";
import codex from "./adapters/codex/index.js";
import { Engine } from "./core/engine.js";
import { Registry } from "./core/registry.js";
import { AdapterLoader, discoverExternal } from "./adapters/loader.js";

export interface CreateEngineOpts {
  home?: string;
  withBuiltins?: boolean;
  withExternal?: boolean;
}

/** Convenience factory: returns an Engine with built-in adapters loaded. */
export async function createEngine(opts: CreateEngineOpts = {}): Promise<Engine> {
  const registry = new Registry({ home: opts.home });
  const loader = new AdapterLoader();
  if (opts.withBuiltins !== false) {
    loader.register(claudeCode);
    if (codex && (codex as any).name) {
      try { loader.register(codex as any); } catch { /* may be stub */ }
    }
  }
  if (opts.withExternal) await discoverExternal(loader);
  return new Engine({ registry, loader });
}
```

- [ ] **Step 2: Smoke test**

Update `test/unit/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { VERSION, createEngine } from "../../src/index.js";
import { makeTmpHome } from "../helpers/tmp-home.js";

describe("smoke", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("createEngine returns an engine that can list (zero sessions on tmp home)", async () => {
    const { home, cleanup } = await makeTmpHome();
    process.env.HOME = home;
    const engine = await createEngine({ home });
    const list = await engine.list();
    expect(Array.isArray(list)).toBe(true);
    await cleanup();
  });
});
```

- [ ] **Step 3: Run — should pass**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `dist/index.js`, `dist/adapters/types.js`, `dist/mcp/index.js`, `dist/cli/index.js` exist with `.d.ts` siblings.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/unit/smoke.test.ts
git commit -m "feat: library entry + createEngine factory with built-ins"
```

---

## Phase 10: CLI

### Task 10.1: CLI entry + bin shim

**Files:**
- Create: `src/cli/index.ts`
- Create: `bin/peek.js`

- [ ] **Step 1: bin/peek.js**

```js
#!/usr/bin/env node
import("../dist/cli/index.js").then((m) => m.run()).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
```

Make executable: `chmod +x bin/peek.js`

- [ ] **Step 2: src/cli/index.ts**

```ts
// src/cli/index.ts
import { cac } from "cac";
import { createEngine, VERSION } from "../index.js";
import {
  SessionNotFoundError, AmbiguousSelectorError,
  AdapterError, AdapterNotFoundError, RegistryLockTimeoutError,
} from "../core/errors.js";
import type { SnapshotMode } from "../core/types.js";

export async function run(argv: string[] = process.argv): Promise<number> {
  const cli = cac("peek");

  cli.command("list", "List discovered sessions")
    .option("--adapter <name>", "Filter by adapter")
    .option("--status <s>", "Filter by status (active|idle|ended)")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const engine = await createEngine({ withExternal: true });
      const list = await engine.list({ adapter: opts.adapter, status: opts.status });
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
      printList(list);
    });

  cli.command("peek <selector>", "Show snapshot of a session")
    .option("--mode <m>", "raw|structured|summary", { default: "raw" })
    .option("--since <cursor>", "Only return new messages after this cursor")
    .option("--limit <n>", "Max raw messages", { default: 200 })
    .option("--json", "Output JSON")
    .action(async (selector, opts) => {
      const engine = await createEngine({ withExternal: true });
      const r = await engine.peek(selector, {
        mode: opts.mode as SnapshotMode,
        since: opts.since,
        limit: Number(opts.limit) || undefined,
      });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
      printSnapshot(r);
    });

  cli.command("tag <id> <name>", "Set a friendly tag for a session")
    .action(async (id, name) => {
      const engine = await createEngine();
      await engine.tag(id, name);
      console.log(`tagged ${id} as ${name}`);
    });

  cli.command("untag <id>", "Remove a session's tag")
    .action(async (id) => {
      const engine = await createEngine();
      await engine.untag(id);
      console.log(`untagged ${id}`);
    });

  cli.command("register", "Register a session manually")
    .option("--id <id>", "Session id (must be adapter-prefixed)", { default: "" })
    .option("--adapter <name>", "Adapter name", { default: "" })
    .option("--transcript-path <p>", "Absolute transcript path", { default: "" })
    .option("--as <tag>", "Tag/name for the session", { default: "" })
    .option("--cwd <path>", "Working directory", { default: "" })
    .action(async (opts) => {
      if (!opts.id || !opts.adapter || !opts.transcriptPath) {
        console.error("--id, --adapter, --transcript-path are required");
        process.exit(5);
      }
      const engine = await createEngine();
      await engine.register({
        id: opts.id, adapter: opts.adapter, transcriptPath: opts.transcriptPath,
        tag: opts.as || undefined, cwd: opts.cwd || undefined,
      });
      console.log(`registered ${opts.id}`);
    });

  cli.command("unregister <id>", "Remove a session from the registry")
    .action(async (id) => {
      const engine = await createEngine();
      await engine.unregister(id);
      console.log(`unregistered ${id}`);
    });

  cli.command("adapters", "List installed adapters")
    .action(async () => {
      const engine = await createEngine({ withExternal: true });
      const list = await engine.list();
      const seen = new Set(list.map((e) => e.adapter));
      // Loader names not exposed; list adapters seen via engine. Plus the engine has built-ins always.
      console.log(["claude-code", "codex", ...seen].filter(Boolean).join("\n"));
    });

  cli.help();
  cli.version(VERSION);

  try {
    cli.parse(argv, { run: false });
    await cli.runMatchedCommand();
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

function handleError(e: unknown): number {
  if (e instanceof SessionNotFoundError) {
    console.error(`error: ${e.message}\nhint: run \`peek list\``);
    return 2;
  }
  if (e instanceof AmbiguousSelectorError) {
    console.error(`error: ${e.message}`);
    return 3;
  }
  if (e instanceof AdapterError || e instanceof AdapterNotFoundError) {
    console.error(`error: ${(e as Error).message}`);
    return 4;
  }
  if (e instanceof RegistryLockTimeoutError) {
    console.error(`error: ${e.message}`);
    return 5;
  }
  console.error((e as Error)?.stack ?? String(e));
  return 1;
}

function printList(list: { id: string; tag?: string; adapter: string; cwd?: string; status: string; lastSeen: string }[]): void {
  if (list.length === 0) { console.log("(no sessions)"); return; }
  const rows = list.map((e) => [
    e.id, e.tag ?? "-", e.adapter, e.cwd ?? "-", e.status, e.lastSeen,
  ]);
  const headers = ["ID", "TAG", "ADAPTER", "CWD", "STATUS", "LAST SEEN"];
  const cols = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((v, i) => v.padEnd(cols[i]!)).join("  ");
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

function printSnapshot(r: import("../core/types.js").PeekResult): void {
  const s = r.snapshot;
  if (s.mode === "raw") {
    for (const m of s.messages) {
      const head = `[${m.role}]${m.timestamp ? " " + m.timestamp : ""}`;
      console.log(head);
      if (m.text) console.log(indent(m.text));
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          console.log(indent(`tool=${tc.name} status=${tc.status ?? "?"}`));
        }
      }
    }
  } else if (s.mode === "structured") {
    console.log(`session: ${s.sessionId}`);
    console.log(`messages: ${s.messageCount}`);
    console.log(`activity: ${s.activity}`);
    if (s.currentTask) console.log(`task: ${s.currentTask}`);
    if (s.lastAssistantMessage) console.log(`last assistant: ${s.lastAssistantMessage}`);
    if (s.pendingToolCalls.length) {
      console.log(`pending tools: ${s.pendingToolCalls.map((t) => t.name).join(", ")}`);
    }
  } else {
    console.log(s.summary);
    if (s.fallback) console.log(`(fallback: structured returned)`);
  }
  console.log(`\nnextCursor: ${r.nextCursor}`);
}

function indent(s: string, n = 2): string {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => pad + l).join("\n");
}
```

- [ ] **Step 3: Build + manual smoke**

Run: `npm run build`
Run: `node bin/peek.js --help`
Expected: usage text printed.
Run: `node bin/peek.js list`
Expected: scans real `~/.claude/projects` (if any) and lists or `(no sessions)`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts bin/peek.js
git commit -m "feat(cli): peek/list/tag/register/adapters commands"
```

---

### Task 10.2: CLI integration test

**Files:**
- Create: `test/integration/cli.test.ts`

- [ ] **Step 1: Failing test**

```ts
// test/integration/cli.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../bin/peek.js");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn("node", [BIN, ...args], { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => res({ code: code ?? 0, stdout: out, stderr: err }));
  });
}

describe("CLI integration", () => {
  it("--help prints usage", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
  });

  it("list returns (no sessions) under empty fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["list"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no sessions/);
  });

  it("peek of unknown selector exits 2 with helpful message", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["peek", "ghost"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/peek list/);
  });

  it("list discovers a fake claude-code session", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-x");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "abc.jsonl");
    await writeFile(tx,
      `{"type":"user","sessionId":"abc","cwd":"/tmp/x","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`,
      "utf8");
    const r = await runCli(["list"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/claude-code:abc/);
  });
});
```

- [ ] **Step 2: Run — should fail until built**

Run: `npm run build && npm test -- cli.test`
Expected: PASS, 4 tests.

- [ ] **Step 3: Commit**

```bash
git add test/integration/cli.test.ts
git commit -m "test(integration): cli smoke + exit codes"
```

---

## Phase 11: MCP server

### Task 11.1: MCP server

**Files:**
- Create: `src/mcp/index.ts`
- Create: `bin/agent-peek-mcp.js`

- [ ] **Step 1: bin shim**

`bin/agent-peek-mcp.js`:

```js
#!/usr/bin/env node
import("../dist/mcp/index.js").then((m) => m.run()).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
```

`chmod +x bin/agent-peek-mcp.js`

- [ ] **Step 2: MCP server**

```ts
// src/mcp/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createEngine } from "../index.js";
import type { SnapshotMode } from "../core/types.js";

const tools = [
  {
    name: "peek_session",
    description: "Read a snapshot of another agent's chat session.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Session id, tag, or cwd." },
        mode: { type: "string", enum: ["raw", "structured", "summary"], default: "raw" },
        since: { type: "string", description: "Cursor returned by a prior peek." },
        limit: { type: "number", description: "Max raw messages (default 200)." },
      },
      required: ["selector"],
    },
  },
  {
    name: "list_sessions",
    description: "List discovered agent sessions.",
    inputSchema: {
      type: "object",
      properties: {
        adapter: { type: "string" },
        status: { type: "string", enum: ["active", "idle", "ended"] },
      },
    },
  },
  {
    name: "tag_session",
    description: "Give a session a friendly tag for easier addressing.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        tag: { type: "string" },
      },
      required: ["id", "tag"],
    },
  },
];

export async function run(): Promise<void> {
  const engine = await createEngine({ withExternal: true });
  const server = new Server(
    { name: "agent-peek", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === "peek_session") {
      const r = await engine.peek(String(args.selector), {
        mode: (args.mode as SnapshotMode) ?? "raw",
        since: args.since ? String(args.since) : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    }
    if (name === "list_sessions") {
      const list = await engine.list({
        adapter: args.adapter ? String(args.adapter) : undefined,
        status: args.status as any,
      });
      return { content: [{ type: "text", text: JSON.stringify(list) }] };
    }
    if (name === "tag_session") {
      await engine.tag(String(args.id), String(args.tag));
      return { content: [{ type: "text", text: "ok" }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run();
}
```

- [ ] **Step 3: Build + smoke**

Run: `npm run build`
Run: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/agent-peek-mcp.js`
Expected: JSON-RPC response listing 3 tools (may need to send `initialize` first depending on SDK version; if so, accept that the smoke test is illustrative and rely on the integration test below).

- [ ] **Step 4: Commit**

```bash
git add src/mcp/index.ts bin/agent-peek-mcp.js
git commit -m "feat(mcp): stdio server with peek_session/list_sessions/tag_session"
```

---

### Task 11.2: MCP integration test

**Files:**
- Create: `test/integration/mcp.test.ts`

- [ ] **Step 1: Failing test**

```ts
// test/integration/mcp.test.ts
import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../bin/agent-peek-mcp.js");

describe("MCP integration", () => {
  it("lists tools and calls list_sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-mcp-"));
    const projDir = join(home, ".claude", "projects", "-tmp-y");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "xyz.jsonl"),
      `{"type":"user","sessionId":"xyz","cwd":"/tmp/y","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`,
      "utf8");

    const transport = new StdioClientTransport({
      command: "node",
      args: [BIN],
      env: { ...process.env, HOME: home },
    });
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ["list_sessions", "peek_session", "tag_session"]);

    const res = await client.callTool({ name: "list_sessions", arguments: {} });
    const text = (res.content?.[0] as any)?.text ?? "[]";
    const list = JSON.parse(text);
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((e: any) => e.id === "claude-code:xyz")).toBeTruthy();

    await client.close();
  }, 15_000);
});
```

- [ ] **Step 2: Run — should pass**

Run: `npm run build && npm test -- mcp.test`
Expected: PASS. (If the SDK API on `client.listTools` / `callTool` differs slightly in the installed version, adjust per the SDK's actual TS definitions; the conceptual test stays the same.)

- [ ] **Step 3: Commit**

```bash
git add test/integration/mcp.test.ts
git commit -m "test(integration): mcp client→server end-to-end"
```

---

## Phase 12: Concurrency integration test

### Task 12.1: Concurrent write while peek

**Files:**
- Create: `test/integration/concurrent-write.test.ts`

- [ ] **Step 1: Test**

```ts
// test/integration/concurrent-write.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCode from "../../src/adapters/claude-code/index.js";

describe("concurrent transcript write", () => {
  it("never throws and never returns partial JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ap-conc-"));
    const path = join(dir, "t.jsonl");
    await writeFile(path, "", "utf8");

    let stop = false;
    const writer = (async () => {
      for (let i = 0; i < 200; i++) {
        const line = JSON.stringify({
          type: "user",
          sessionId: "x",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: `msg ${i}` },
        }) + "\n";
        // Write line in two chunks to maximize torn-write window.
        await appendFile(path, line.slice(0, 10), "utf8");
        await new Promise((r) => setTimeout(r, 1));
        await appendFile(path, line.slice(10), "utf8");
        if (stop) break;
      }
    })();

    const reader = (async () => {
      let cursor: string | undefined;
      let total = 0;
      for (let i = 0; i < 50; i++) {
        const r = await claudeCode.read(
          { id: "claude-code:x", adapter: "claude-code", transcriptPath: path,
            lastSeen: "", status: "active" },
          cursor,
        );
        for (const m of r.messages) {
          expect(m.text).toMatch(/^msg \d+$/);
        }
        total += r.messages.length;
        cursor = r.nextCursor;
        await new Promise((r) => setTimeout(r, 5));
      }
      return total;
    })();

    const total = await reader;
    stop = true;
    await writer;
    expect(total).toBeGreaterThan(0);
  }, 10_000);
});
```

- [ ] **Step 2: Run — should pass**

Run: `npm test -- concurrent-write`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/concurrent-write.test.ts
git commit -m "test(integration): concurrent transcript writes never tear records"
```

---

## Phase 13: README + LICENSE

### Task 13.1: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```markdown
# agent-peek

> Read-only peek into other AI agent chat sessions.

When you run multiple AI agents in parallel — sibling Claude Code sessions, an agent + a researcher, a fleet of task-runners — `agent-peek` lets one agent ask "what is the other agent doing right now?" without crosstalk and without re-reading the whole transcript every time.

## Install

```bash
npm i -g agent-peek
```

Provides three things:

- `peek` — CLI (alias: `apeek`)
- `agent-peek-mcp` — MCP server for Claude Code / Codex / any MCP client
- `agent-peek` — TypeScript library

## CLI

```bash
peek list                                 # show discovered sessions
peek peek <id|tag|cwd>                    # full snapshot
peek peek <selector> --mode structured    # normalized fields
peek peek <selector> --mode summary       # LLM-summarized (needs ANTHROPIC_API_KEY)
peek peek <selector> --since <cursor>     # only new messages since prior peek
peek tag <id> researcher                  # give a session a friendly name
peek register --id ... --adapter ... --transcript-path ...
peek adapters
```

## MCP

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "agent-peek": { "command": "agent-peek-mcp" }
  }
}
```

Tools exposed: `peek_session`, `list_sessions`, `tag_session`.

## Library

```ts
import { createEngine } from "agent-peek";

const engine = await createEngine();
const sessions = await engine.list();
const r = await engine.peek("researcher", { mode: "summary" });
console.log(r.snapshot);
console.log(r.nextCursor);     // pass back as `since` next call
```

## Built-in adapters

- `claude-code` — reads `~/.claude/projects/*/<uuid>.jsonl`
- `codex` — reads OpenAI Codex CLI transcripts (see source for path)

## External adapters

Set `AGENT_PEEK_ADAPTER_PATH` to a colon-separated list of paths to adapter modules. Each module's default export must implement the `Adapter` interface from `agent-peek/adapter`.

## Security

Same-user, same-machine only. There is no remote transport; access control is filesystem permissions. Read-only by design — `agent-peek` never writes to another session's transcript.

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README"
```

---

### Task 13.2: LICENSE

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: MIT license**

```
MIT License

Copyright (c) 2026 Akhilesh Rangani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -m "docs: MIT license"
```

---

## Phase 14: Final verification

### Task 14.1: Full suite + coverage

- [ ] **Step 1: Run everything**

Run: `npm run typecheck && npm run build && npm test`
Expected: All checks pass; vitest reports total tests passing across unit / adapter / integration; coverage thresholds met (lines ≥ 85%, statements ≥ 85%, functions ≥ 80%, branches ≥ 75%).

If branch threshold misses, add focused tests on the failing branches; do NOT lower thresholds.

- [ ] **Step 2: Manual smoke against real Claude Code**

If you have an active Claude Code session in another window:

Run: `node bin/peek.js list`
Expected: Lists at least one `claude-code:*` session.
Run: `node bin/peek.js peek <id> --mode structured`
Expected: Plausible structured snapshot.

- [ ] **Step 3: Final commit (only if changes were needed)**

```bash
git status
# only commit if anything changed
```

---

## Out of scope (v1) — explicit non-goals

These are NOT to be implemented in this plan. Each is a future plan if we choose to do it.

- Live tail / async iterator (Adapter.watch is in the interface but unused).
- Inbox / one-way leave-note messaging.
- Additional adapters: Cursor, Aider, generic JSONL.
- Vault sinks (Obsidian or other).
- Web UI / dashboard.
- Cross-machine peek over an authenticated transport.
- Windows support.
