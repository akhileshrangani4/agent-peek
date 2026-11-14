// test/golden/normalize.ts
//
// The one place volatile output is made stable. The golden suites record what the CLI
// and stdio MCP server print for the fixture home; everything below is a value that
// legitimately differs between two runs of the same code, and nothing else is touched.
// If a rule here starts hiding a real difference, narrow the rule; do not add a second
// normaliser somewhere else.
//
// Rules, applied to every string in a parsed JSON value (keys included) or to raw text:
//   1. Absolute paths. The fixture $HOME becomes `<HOME>`, the checkout `<REPO>` and the
//      node binary `<NODE>`. Longest prefix first. The OS temp dir is deliberately not
//      rewritten: the fixture transcripts' own cwd `/tmp/repo` is data under test, and
//      the only temp path a run creates is $HOME itself.
//   2. Host identity. `<user>@<hostname>` (the anonymous author/owner fallback) becomes
//      `<USER>@<HOST>`.
//   3. Run-time instants. An ISO-8601 instant no older than RUN_WINDOW_MS before the run
//      started was produced by this run (a post's createdAt, a claim's expiresAt, a scan
//      time), so it becomes `<NOW>`. Fixture instants are pinned to 2026-04-28 and stay
//      as recorded, because they are the data under test.
//   4. Generated ids. A UUID or feed post id (`<base36 time>-<8 hex>`) that did not come
//      from the fixture becomes `<ID:n>`, numbered by first appearance across one suite
//      run, so "the post expand returned is the post feed listed" survives normalisation.
//   5. Opaque cursors. A base64url string that decodes to a JSON object is replaced by
//      `{ "$cursor": <decoded, normalised> }`, so a cursor's content is compared field by
//      field instead of churning on an embedded timestamp.
//   6. Versions. The package version becomes `<VERSION>` (a release bump is not a
//      behaviour change) and the Node version `<NODE_VERSION>`.
//   7. Durations. Numeric fields whose name ends in `Ms` and that measure elapsed time
//      (`durationMs`, `elapsedMs`, `latencyMs`, `tookMs`) become `"<MS>"`.
import { hostname, userInfo } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./fixture-home.js";

/** How far before the run's start an instant may lie and still count as run-time. */
export const RUN_WINDOW_MS = 48 * 3600 * 1000;

const ELAPSED_FIELDS = new Set(["durationMs", "elapsedMs", "latencyMs", "tookMs"]);

const PACKAGE_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;

// Bounded so the version does not match inside a longer dotted number (10.6.0, 0.6.01).
const VERSION_RE = new RegExp(`(?<![\\d.])${PACKAGE_VERSION.replace(/\./g, "\\.")}(?![\\d.])`, "g");
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const POST_ID_RE = /\b[0-9a-z]{9}-[0-9a-f]{8}\b/g;
const BASE64URL_RE = /^[A-Za-z0-9_-]{16,}={0,2}$/;

export interface NormalizeContext {
  home: string;
  runStartedAt: number;
  /** Ids that come from the fixture and must be kept verbatim. */
  stableIds: string[];
}

export class Normalizer {
  private readonly paths: [string, string][];
  private readonly hostIdentity = `${userInfo().username}@${hostname()}`;
  private readonly ids = new Map<string, string>();
  private readonly stable: Set<string>;

  constructor(private readonly ctx: NormalizeContext) {
    const pairs: [string, string][] = [
      [ctx.home, "<HOME>"],
      [REPO_ROOT, "<REPO>"],
      [process.execPath, "<NODE>"],
    ];
    // Longest first, so a more specific prefix wins over one it contains.
    this.paths = pairs.sort((a, b) => b[0].length - a[0].length);
    this.stable = new Set(ctx.stableIds.map((id) => id.toLowerCase()));
  }

  /** Normalise any JSON-shaped value. Generated-id numbering is shared by every call on one Normalizer. */
  value(input: unknown, key?: string): unknown {
    if (typeof input === "string") return this.string(input);
    if (typeof input === "number" && key !== undefined && ELAPSED_FIELDS.has(key)) return "<MS>";
    if (Array.isArray(input)) return input.map((v) => this.value(v));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) out[this.text(k)] = this.value(v, k);
      return out;
    }
    return input;
  }

  /** Normalise one string value: an opaque cursor becomes its decoded object, anything else is rewritten text. */
  string(input: string): unknown {
    const cursor = this.cursor(input);
    return cursor !== undefined ? cursor : this.text(input);
  }

  /** Apply the text rules (1-4, 6) to a string; used for object keys, which cannot become objects. */
  text(input: string): string {
    let s = input;
    for (const [from, to] of this.paths) s = s.split(from).join(to);
    s = s.split(this.hostIdentity).join("<USER>@<HOST>");
    s = s.replace(ISO_RE, (iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && t >= this.ctx.runStartedAt - RUN_WINDOW_MS ? "<NOW>" : iso;
    });
    s = s.replace(UUID_RE, (id) => this.id(id));
    s = s.replace(POST_ID_RE, (id) => this.id(id));
    s = s.split(process.version).join("<NODE_VERSION>");
    s = s.replace(VERSION_RE, "<VERSION>");
    return s;
  }

  private id(raw: string): string {
    if (this.stable.has(raw.toLowerCase())) return raw;
    let label = this.ids.get(raw);
    if (!label) {
      label = `<ID:${this.ids.size + 1}>`;
      this.ids.set(raw, label);
    }
    return label;
  }

  private cursor(input: string): unknown {
    if (!BASE64URL_RE.test(input)) return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if (!decoded || typeof decoded !== "object") return undefined;
    return { $cursor: this.value(decoded) };
  }
}
