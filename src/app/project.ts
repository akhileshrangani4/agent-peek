// src/app/project.ts
//
// The project a service call is about. Services take it explicitly and never read
// `process.cwd()`: the CLI, a stdio MCP server and an HTTP host each decide differently
// what "this project" means, and only the front end knows which rule applies.
// D2's `resolveProject()` grows this into a portable id; the directory stays the anchor.

export interface ProjectRef {
  /**
   * A directory inside the project's working tree, exactly as the front end chose it.
   * Not normalised here: author resolution matches it against session cwds, so turning
   * a caller's relative `dir` into an absolute one would change who a post is from.
   */
  readonly dir: string;
}

export function projectAt(dir: string): ProjectRef {
  return { dir };
}
