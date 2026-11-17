# agent-peek 0.7 design docs

These documents were exported from the design workspace on 2026-11-17 and are now the source of truth for the 0.7 design. Edit them here; there is no other copy.

| File | What it is |
|---|---|
| [spec-0.7.md](spec-0.7.md) | The approved 0.7 spec (D1–D9): decisions, deliverables, acceptance criteria, locked decisions and risks. |
| [spec-0.7.html](spec-0.7.html) | The spec's original HTML, byte-for-byte, kept so nothing is lost in conversion. |
| [spec-0.7-figures/](spec-0.7-figures/) | Inline SVG figures cut out of the spec (`fig-01.svg`: the 0.7 system boundary). |
| [research-overview.md](research-overview.md) | Consolidated research behind the spec: off-localhost, cloud agents and the knowledge graph. |
| [research-a-codebase-map.md](research-a-codebase-map.md) | Research A: codebase map, data stores, localhost coupling and the test suite at `main@b6197fe`. |
| [research-b-cloud-architecture.md](research-b-cloud-architecture.md) | Research B: off-localhost and cloud-agent architecture options. |
| [research-c-graph-db.md](research-c-graph-db.md) | Research C: graph database and conversation knowledge-graph options. |
| [research-d-opencode-retry-monitor.md](research-d-opencode-retry-monitor.md) | Research D: OpenCode V2 and the opt-in retry monitor (spec D8). |
| [research-e-issues-1-7.md](research-e-issues-1-7.md) | Research E: reproductions and fixes for open issues #1–#7 (spec D9). |

## How the export was made

- **Research documents** are the source Markdown, written verbatim. The only edits replace design-workspace document ids with relative links to the files above, and one internal task id in Research D with a description of that task (it became PR #17).
- **The spec** was converted from `spec-0.7.html` with pandoc 3.6.4 (`html` → `gfm`). Before conversion, a script rewrote the Blueprint-only elements into plain HTML:
  - `bp-callout` → a blockquote whose first line is the callout type and label (`Ref: …`, `Invariant: …`, `Locked: …`); `bp-note` → a blockquote labelled `Note`.
  - `bp-table` → the plain table it wraps. Bullet lists inside table cells became inline `•` runs so every table stays a Markdown table.
  - `bp-eyebrow` and `bp-subheader` → paragraphs; `bp-toc` → a generated contents list in the same place.
  - The one `<pre>` block → a fenced `sql` block. The spec has no `bp-source` or `bp-cite` elements.
  - The inline SVG → `spec-0.7-figures/fig-01.svg`, cut from the source text unchanged except for an `xmlns`, and colours that the Blueprint stylesheet used to supply. It is linked as an image where it stood.
- A check script confirmed that every `h2` section and every acceptance-criterion ID in the HTML appears in the Markdown. Its output is in the export PR.
