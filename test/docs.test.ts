import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADR_DIR = join(ROOT, "docs", "adr");

/** Relative markdown link targets in `markdown`, without anchors; web and mail links skipped. */
function relativeLinks(markdown: string): string[] {
  const targets = [...markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!);
  return targets
    .filter((target) => !/^(?:[a-z]+:|#)/i.test(target))
    .map((target) => target.split("#")[0]!);
}

/** The body of the `## <heading>` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string | undefined {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) return undefined;
  const rest = markdown.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("ADR 0002 (D1.1)", () => {
  const adrFile = readdirSync(ADR_DIR).find((name) => name.startsWith("0002-"));
  const adr = adrFile ? readFileSync(join(ADR_DIR, adrFile), "utf8") : "";

  it("lives beside ADR 0001 with status Accepted", () => {
    expect(adrFile).toBe("0002-graph-and-network-retention.md");
    expect(section(adr, "Status")?.trim()).toBe("Accepted.");
  });

  it("names the leave and never-leave lists from spec D1", () => {
    const mayLeave = adr.slice(adr.indexOf("### What may leave a machine"), adr.indexOf("### What never leaves a machine"));
    for (const item of ["provenance pointers", "Repo-relative paths", "commit SHAs", "skill keys", "branch names", "adapter names", "model ids", "Feed posts", "Derived status posts", "2,000"]) {
      expect(mayLeave).toContain(item);
    }
    const neverLeaves = adr.slice(adr.indexOf("### What never leaves a machine"), adr.indexOf("### Local text index"));
    for (const item of ["Message text", "Tool input", "Tool output", "Prompt text", "Absolute paths", "Hostnames"]) {
      expect(neverLeaves).toContain(item);
    }
  });

  it("names the guard that enforces it, at a path that exists", () => {
    expect(adr).toContain("assertExportable(payload)");
    expect(existsSync(join(ROOT, "src", "export", "assert-exportable.ts"))).toBe(true);
  });
});

describe("README privacy section (D1.1)", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  it("links to ADR 0002 from a Privacy section, and the link resolves", () => {
    const privacy = section(readme, "Privacy");
    expect(privacy).toBeDefined();
    const adrLinks = relativeLinks(privacy ?? "").filter((target) => target.startsWith("docs/adr/0002-"));
    expect(adrLinks).toEqual(["docs/adr/0002-graph-and-network-retention.md"]);
    for (const target of adrLinks) expect(existsSync(join(ROOT, target)), target).toBe(true);
  });

  it("has no broken relative links in the README or the ADRs", () => {
    const sources = [
      { file: join(ROOT, "README.md"), text: readme },
      ...readdirSync(ADR_DIR).map((name) => ({ file: join(ADR_DIR, name), text: readFileSync(join(ADR_DIR, name), "utf8") })),
    ];
    const broken = sources.flatMap(({ file, text }) =>
      relativeLinks(text)
        .filter((target) => !existsSync(resolve(dirname(file), target)))
        .map((target) => `${file}: ${target}`));
    expect(broken).toEqual([]);
  });
});
