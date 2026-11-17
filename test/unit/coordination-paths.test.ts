// test/unit/coordination-paths.test.ts
//
// Issue #7 (D9.1): a relative path resolves against the directory its tool call ran
// in, not the session cwd. Fixtures follow Research E §7: a session that reads two
// files, then edits two files under apps/server, one through `cd apps/server && sed -i`
// and one through a Codex `exec_command` with `workdir`.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferTouchedFiles, inferWritingFiles } from "../../src/core/coordination.js";
import { classifyFileEvents } from "../../src/core/file-events.js";
import { gitToplevel, toRepoRelative } from "../../src/core/repo-path.js";
import { isPlausibleWriteTarget, parseShell, resolveIn, scriptFileOps, scriptPaths, shellWords } from "../../src/core/shell.js";
import { toStructured } from "../../src/core/snapshot.js";
import { resolveCallCwd, toolCallFileOps, toolCallPaths } from "../../src/core/tool-paths.js";
import type { RawMessage, ToolCall } from "../../src/core/types.js";

/** A temp checkout (a `.git` directory at its root) holding the given files. */
function workspace(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ap-paths-"));
  mkdirSync(join(root, ".git"));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "old\n");
  }
  return root;
}

const call = (name: string, input: unknown, extra: Partial<ToolCall> = {}): RawMessage => ({
  role: "assistant",
  toolCalls: [{ name, input, status: "pending", ...extra }],
  raw: {},
});

const SECTION_7_FILES = ["apps/server/src/apps/service.ts", "apps/server/src/mcp/tools.ts", "docs/_template.md", "src/real.ts"];

function section7Session(ws: string): RawMessage[] {
  return [
    { role: "user", text: "Rename createApp in the server.", raw: {} },
    call("Read", { file_path: "docs/_template.md" }),
    call("Bash", { command: "rg createApp src/real.ts" }),
    call("Bash", { command: "cd apps/server && sed -i 's/old/new/' src/apps/service.ts" }),
    call("exec_command", { cmd: "sed -i 's/old/new/' src/mcp/tools.ts", workdir: join(ws, "apps/server") }),
  ];
}

describe("per-call working directory (#7, D9.1)", () => {
  it("lists the two real edits as wrote and the two reads as read", () => {
    const ws = workspace(SECTION_7_FILES);
    expect(classifyFileEvents(section7Session(ws), ws)).toEqual([
      { path: join(ws, "apps/server/src/apps/service.ts"), relPath: "apps/server/src/apps/service.ts", role: "wrote", state: "modified" },
      { path: join(ws, "apps/server/src/mcp/tools.ts"), relPath: "apps/server/src/mcp/tools.ts", role: "wrote", state: "modified" },
      { path: join(ws, "docs/_template.md"), relPath: "docs/_template.md", role: "read" },
      { path: join(ws, "src/real.ts"), relPath: "src/real.ts", role: "read" },
    ]);
  });

  it("reports the real edits as writing, and keeps touchedFiles as every path touched", () => {
    const ws = workspace(SECTION_7_FILES);
    const messages = section7Session(ws);
    const edits = [join(ws, "apps/server/src/apps/service.ts"), join(ws, "apps/server/src/mcp/tools.ts")];
    expect(inferWritingFiles(messages, ws).sort()).toEqual(edits);
    expect(toStructured("s", messages, ws).writingFiles.sort()).toEqual(edits);
    expect(inferTouchedFiles(messages, ws).sort()).toEqual([...edits, join(ws, "docs/_template.md"), join(ws, "src/real.ts")].sort());
  });

  it("never pins an edit on a same-named decoy at the session root", () => {
    const ws = workspace([...SECTION_7_FILES, "src/apps/service.ts", "src/mcp/tools.ts"]);
    const messages = section7Session(ws);
    const decoys = [join(ws, "src/apps/service.ts"), join(ws, "src/mcp/tools.ts")];
    const writing = toStructured("s", messages, ws).writingFiles;
    for (const decoy of decoys) {
      expect(writing).not.toContain(decoy);
      expect(inferTouchedFiles(messages, ws)).not.toContain(decoy);
      expect(classifyFileEvents(messages, ws).find((file) => file.path === decoy)).toBeUndefined();
    }
    expect(writing.sort()).toEqual([join(ws, "apps/server/src/apps/service.ts"), join(ws, "apps/server/src/mcp/tools.ts")]);
  });

  it("gives the same relPath for the same file in two clones at different paths", () => {
    const first = workspace(SECTION_7_FILES);
    const second = workspace(SECTION_7_FILES);
    const a = classifyFileEvents(section7Session(first), first);
    const b = classifyFileEvents(section7Session(second), second);
    expect(a.map((file) => file.path)).not.toEqual(b.map((file) => file.path));
    expect(a.map((file) => file.relPath)).toEqual(b.map((file) => file.relPath));
    expect(a.map((file) => file.relPath)).toEqual(["apps/server/src/apps/service.ts", "apps/server/src/mcp/tools.ts", "docs/_template.md", "src/real.ts"]);
  });

  it("keeps an edit relative to a cwd it cannot know out of every list", () => {
    const ws = workspace(SECTION_7_FILES);
    const messages = [
      call("Bash", { command: "cd \"$SERVER\" && sed -i 's/a/b/' src/real.ts" }),
      call("exec_command", { cmd: "sed -i 's/a/b/' src/real.ts", workdir: "~/elsewhere" }),
    ];
    expect(inferWritingFiles(messages, ws)).toEqual([]);
    expect(classifyFileEvents(messages, ws)).toEqual([]);
  });
});

describe("resolveCallCwd", () => {
  const session = "/work/repo";
  it("uses the session cwd when the call names none", () => {
    expect(resolveCallCwd({ name: "Bash", input: { command: "ls" } }, session)).toBe(session);
    expect(resolveCallCwd({ name: "Bash" }, session)).toBe(session);
    expect(resolveCallCwd({ name: "Bash", input: { workdir: "  " } }, session)).toBe(session);
  });

  it("uses an absolute workdir or cwd as given", () => {
    expect(resolveCallCwd({ name: "exec_command", input: { workdir: "/work/repo/apps/server/" } }, session)).toBe("/work/repo/apps/server/");
    expect(resolveCallCwd({ name: "shell", input: { cwd: "/other" } }, session)).toBe("/other");
  });

  it("resolves a relative workdir against the session cwd", () => {
    expect(resolveCallCwd({ name: "exec_command", input: { workdir: "apps/server" } }, session)).toBe("/work/repo/apps/server");
    expect(resolveCallCwd({ name: "exec_command", input: { workdir: "apps/server" } }, undefined)).toBe("apps/server");
  });

  it("is unknown for a workdir the text cannot resolve", () => {
    for (const workdir of ["~/repo", "$HOME/repo", "`pwd`/x", "src/*"]) {
      expect(resolveCallCwd({ name: "exec_command", input: { workdir } }, session)).toBeUndefined();
    }
  });

  it("routes named-argument paths and command paths through the call's directory", () => {
    const tool: ToolCall = { name: "exec_command", input: { cmd: "cat src/a.ts", workdir: "/work/repo/pkg" } };
    expect(toolCallPaths(tool, session)).toEqual(["/work/repo/pkg/src/a.ts"]);
    const edit: ToolCall = { name: "Edit", input: { file_path: "src/a.ts", cwd: "/work/repo/pkg" } };
    expect(toolCallPaths(edit, session)).toEqual(["/work/repo/pkg/src/a.ts"]);
    expect(toolCallFileOps(edit, session)).toEqual([{ op: "write", path: "/work/repo/pkg/src/a.ts", mode: "modify" }]);
  });

  it("names what each named tool does", () => {
    expect(toolCallFileOps({ name: "Write", input: { file_path: "a.ts" } }, session)).toEqual([{ op: "write", path: "/work/repo/a.ts", mode: "write" }]);
    expect(toolCallFileOps({ name: "Delete", input: { path: "a.ts" } }, session)).toEqual([{ op: "delete", path: "/work/repo/a.ts" }]);
    // A home-relative path names a directory the transcript does not; it is never joined to the cwd.
    expect(toolCallFileOps({ name: "Bash", input: { command: "touch ~/x.ts" } }, undefined)).toEqual([]);
    expect(toolCallFileOps({ name: "Bash", input: { command: "touch ~/x.ts" } }, session)).toEqual([]);
    expect(toolCallPaths({ name: "Read", input: { file_path: "~/notes.md" } }, session)).toEqual([]);
  });
});

describe("shell reader", () => {
  const dirs = (script: string, base = "/r") => parseShell(script, base).map((command) => [command.words[0], command.dir]);

  it("applies cd segments in order across &&, ; and ||", () => {
    expect(dirs("cd apps/server && sed -i x src/a.ts")).toEqual([["cd", "/r"], ["sed", "/r/apps/server"]]);
    expect(dirs("cd a; cd ..; touch x.ts")).toEqual([["cd", "/r"], ["cd", "/r/a"], ["touch", "/r"]]);
    expect(dirs("cd a || exit 1\ntouch x.ts")).toEqual([["cd", "/r"], ["exit", "/r/a"], ["touch", "/r/a"]]);
    expect(dirs("cd /abs/dir/ && ls")).toEqual([["cd", "/r"], ["ls", "/abs/dir"]]);
    expect(dirs("cd -P a && ls")).toEqual([["cd", "/r"], ["ls", "/r/a"]]);
  });

  it("scopes a cd to its subshell, pipeline or background job", () => {
    expect(dirs("(cd sub && touch a.ts); touch b.ts")).toEqual([["cd", "/r"], ["touch", "/r/sub"], ["touch", "/r"]]);
    expect(dirs("cd sub | cat; touch b.ts")).toEqual([["cd", "/r"], ["cat", "/r"], ["touch", "/r"]]);
    expect(dirs("cd sub & touch b.ts")).toEqual([["cd", "/r"], ["touch", "/r"]]);
  });

  it("follows pushd and popd", () => {
    expect(dirs("pushd sub && touch a.ts && popd && touch b.ts")).toEqual([
      ["pushd", "/r"], ["touch", "/r/sub"], ["popd", "/r/sub"], ["touch", "/r"],
    ]);
    expect(dirs("popd; touch a.ts")).toEqual([["popd", "/r"], ["touch", undefined]]);
  });

  it("loses the directory after a cd it cannot read", () => {
    for (const target of ["", "-", "~", "~/x", "\"$DIR\"", "$(mktemp -d)"]) {
      expect(dirs(`cd ${target}; touch a.ts`).at(-1)).toEqual(["touch", undefined]);
    }
  });

  it("resolves cd to the git toplevel when given a resolver", () => {
    const commands = parseShell("cd \"$(git rev-parse --show-toplevel)\" && touch a.ts", "/r/pkg/sub", { toplevel: () => "/r" });
    expect(commands.at(-1)?.dir).toBe("/r");
    expect(parseShell("cd `git rev-parse --show-toplevel` && touch a.ts", "/r/pkg").at(-1)?.dir).toBeUndefined();
  });

  it("reads heredoc bodies as data, not commands", () => {
    const script = "cat > out.ts <<'EOF'\ncd elsewhere\nrm src/a.ts\nEOF\ntouch b.ts";
    expect(dirs(script)).toEqual([["cat", "/r"], ["touch", "/r"]]);
    expect(scriptFileOps(script, "/r")).toEqual([
      { op: "write", path: "/r/out.ts", mode: "write" },
      { op: "write", path: "/r/b.ts", mode: "write" },
    ]);
    expect(dirs("cat <<-EOF\n\tcd x\n\tEOF\ntouch b.ts")).toEqual([["cat", "/r"], ["touch", "/r"]]);
  });

  it("ignores separators inside quotes, comments and command substitution", () => {
    expect(dirs("echo 'a && cd x' && touch b.ts")).toEqual([["echo", "/r"], ["touch", "/r"]]);
    expect(dirs("echo \"$(cd x && pwd)\" && touch b.ts")).toEqual([["echo", "/r"], ["touch", "/r"]]);
    expect(dirs("# cd x\ntouch b.ts")).toEqual([["touch", "/r"]]);
    expect(dirs("touch \\\n  b.ts")).toEqual([["touch", "/r"]]);
  });

  it("names moves, git moves and deletes", () => {
    expect(scriptFileOps("mv a.ts b.ts", "/r")).toEqual([{ op: "move", from: "/r/a.ts", to: "/r/b.ts" }]);
    expect(scriptFileOps("mv a.ts b.ts lib/", "/r")).toEqual([
      { op: "move", from: "/r/a.ts", to: "/r/lib/a.ts" },
      { op: "move", from: "/r/b.ts", to: "/r/lib/b.ts" },
    ]);
    expect(scriptFileOps("mv -f a.ts lib", "/r")).toEqual([{ op: "move", from: "/r/a.ts", to: "/r/lib/a.ts" }]);
    expect(scriptFileOps("git mv a.ts b.ts", "/r")).toEqual([{ op: "move", from: "/r/a.ts", to: "/r/b.ts" }]);
    expect(scriptFileOps("git -C pkg mv a.ts b.ts", "/r")).toEqual([{ op: "move", from: "/r/pkg/a.ts", to: "/r/pkg/b.ts" }]);
    expect(scriptFileOps("git -c core.x=1 rm -r src/a.ts", "/r")).toEqual([{ op: "delete", path: "/r/src/a.ts" }]);
    expect(scriptFileOps("git rm --cached a.ts", "/r")).toEqual([]);
    expect(scriptFileOps("git -C \"$D\" rm a.ts", "/r")).toEqual([]);
    expect(scriptFileOps("rm -f a.ts b.ts", "/r")).toEqual([{ op: "delete", path: "/r/a.ts" }, { op: "delete", path: "/r/b.ts" }]);
    expect(scriptFileOps("sudo rm x.ts && FOO=1 unlink y.ts", "/r")).toEqual([{ op: "delete", path: "/r/x.ts" }, { op: "delete", path: "/r/y.ts" }]);
    expect(scriptFileOps("rm $TMP/x.ts", "/r")).toEqual([]);
  });

  it("names in-place edits, copies, redirects and patches", () => {
    expect(scriptFileOps("sed -i '' 's/x/y/' src/a.ts", "/r")).toEqual([{ op: "write", path: "/r/src/a.ts", mode: "modify" }]);
    expect(scriptFileOps("sed --in-place 's/x/y/' src/a.ts", "/r")).toEqual([{ op: "write", path: "/r/src/a.ts", mode: "modify" }]);
    expect(scriptFileOps("perl -i -pe 's/x/y/' src/a.ts", "/r")).toEqual([{ op: "write", path: "/r/src/a.ts", mode: "modify" }]);
    expect(scriptFileOps("sed 's/x/y/' src/a.ts", "/r")).toEqual([]);
    expect(scriptFileOps("cp a.ts b.ts", "/r")).toEqual([{ op: "write", path: "/r/b.ts", mode: "write" }]);
    // An option's value is not a file: `-s 0`, `-d yesterday`, `-m 755`.
    expect(scriptFileOps("truncate -s 0 log.txt", "/r")).toEqual([{ op: "write", path: "/r/log.txt", mode: "modify" }]);
    expect(scriptFileOps("touch -d yesterday a.ts", "/r")).toEqual([{ op: "write", path: "/r/a.ts", mode: "write" }]);
    expect(scriptFileOps("mkdir -p -m 755 out", "/r")).toEqual([{ op: "write", path: "/r/out", mode: "write" }]);
    expect(scriptFileOps("cd sub && echo hi > ../x.ts 2>&1", "/r")).toEqual([{ op: "write", path: "/r/x.ts", mode: "write" }]);
    expect(scriptFileOps("echo '() => x' >> /dev/null", "/r")).toEqual([]);
    expect(scriptFileOps("*** Begin Patch\n*** Add File: n.ts\n+x\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-don't\n+do\n*** Delete File: c.ts\n*** End Patch", "/r")).toEqual([
      { op: "write", path: "/r/n.ts", mode: "create" },
      { op: "write", path: "/r/a.ts", mode: "modify" },
      { op: "move", from: "/r/a.ts", to: "/r/b.ts" },
      { op: "delete", path: "/r/c.ts" },
    ]);
  });

  it("scrapes paths a command names, resolved where it ran", () => {
    expect(scriptPaths("cd apps && cat docs/a.md; rg x ./b.ts", "/r")).toEqual(["/r/apps/docs/a.md", "/r/apps/b.ts"]);
    expect(scriptPaths("curl https://x.dev/src/a.ts && cat node_modules/x/y.js", "/r")).toEqual([]);
    expect(scriptPaths("cd \"$X\" && cat src/a.ts /abs/b.ts", "/r")).toEqual(["/abs/b.ts"]);
  });

  it("splits words with quotes removed and redirects dropped", () => {
    expect(shellWords("git commit -m \"a b\" 'c d' > out.txt 2>&1")).toEqual(["git", "commit", "-m", "a b", "c d"]);
    expect(resolveIn(undefined, "a.ts")).toBeUndefined();
    expect(resolveIn(undefined, "/a/b/")).toBe("/a/b");
    expect(resolveIn("/r", "  ")).toBeUndefined();
    expect(isPlausibleWriteTarget("src/a.ts")).toBe(true);
    for (const value of ["", "$X", "a;b", "(x)", "a=b"]) expect(isPlausibleWriteTarget(value)).toBe(false);
  });
});

describe("repo-relative paths", () => {
  it("finds the toplevel of a checkout, a linked worktree and a submodule", () => {
    const ws = workspace(["src/a.ts"]);
    expect(gitToplevel(join(ws, "src/a.ts"))).toBe(ws);
    expect(toRepoRelative(join(ws, "src/a.ts"))).toBe("src/a.ts");
    const worktree = mkdtempSync(join(tmpdir(), "ap-worktree-"));
    writeFileSync(join(worktree, ".git"), `gitdir: ${ws}/.git/worktrees/x\n`);
    expect(toRepoRelative(join(worktree, "pkg/b.ts"))).toBe("pkg/b.ts");
  });

  it("is undefined outside a repo, for relative paths and for the toplevel itself", () => {
    const exists = (path: string) => path === "/r/.git";
    expect(toRepoRelative("/elsewhere/a.ts", exists)).toBeUndefined();
    expect(toRepoRelative("src/a.ts", exists)).toBeUndefined();
    expect(toRepoRelative("/r", exists)).toBeUndefined();
    expect(toRepoRelative("/r/src/../lib/a.ts", exists)).toBe("lib/a.ts");
  });
});
