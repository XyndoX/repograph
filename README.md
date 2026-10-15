# repograph

A Claude Code mod that puts your repo in a side pane with three tabs: **Files**, an Obsidian-style **Graph** of its dependencies, and a lazygit-style **Changes** view to review what your agent is editing while it works.

- **Graph tab**: drawn in real pixels in terminals with the kitty graphics protocol (**Ghostty, cmux, kitty**): soft anti-aliased lines, round nodes, labels as crisp terminal text on top. Elsewhere (tmux, iTerm2) `p` switches to a braille text drawing.
  - Three levels, `m` cycles them: **folders** (a map of the repo: each folder one node, links summed), **files** (imports), **functions** (calls). A big repo opens on folders.
  - **Scope**: click a folder node twice, press `g` on a folder in the Files tab, or run `/repograph apps/web`. The graph then shows what's inside that folder, and everything it links to outside as hollow nodes named after the folder they leave by. The breadcrumb (`⌂ repo / apps / web`) and `u` go back up.
  - **Levels** (folders mode): `[` `]` (or `‹ ›`) set how deep the folder map splits: level 1 is the top folders, level 2 their subfolders (`src/components`, `src/stores`, …), up to 6.
  - **Focus and depth**: click a node and the graph narrows to it and its neighbours. In files and functions mode `[` `]` set the depth, 1 to 5 rings. What the focus imports or calls is purple (→), what uses it is teal (←), and the bottom lines list both. `g` shows the whole graph again with the focus highlighted.
  - Hover a node to see its path; drag to pan, wheel or `+` `-` to zoom.
- **Files tab**: the repo's folders with link counts per file (`←` used by, `→` imports). Enter on a file shows it in the graph; `g` on a folder graphs that folder.
- `/` search box: type a file or function name, Enter focuses and centres it.
- **Changes tab**: every file changed since the last commit (tracked edits first, untracked folders as one row) with `+`/`-` counts, and the selected file's diff below. It rereads git every 2.5 s and after each tool call, so you can review while the agent works. `space` marks a file reviewed (✓); if the agent edits it again it reopens (●). The tab title counts what's still open: `Changes 3/5`.
- Files Claude edits turn orange, and the graph rescans after the turn.

## Install

```text
claude plugin marketplace add XyndoX/repograph
claude plugin install repograph@repograph --scope user
```

Then `/tui fullscreen` (the pane docks to the right) and `/repograph` (or `/repograph functions`, `/repograph changes`). Click the pane once to give it the keyboard.

## Keys

| Key | Does |
|---|---|
| `1` / `2` / `3` | Files / Graph / Changes |
| click, drag, scroll | focus a node (again: open a folder), pan, zoom |
| arrows, `+` `-`, `0` | pan, zoom, reset the view |
| `m` | folders → files → functions |
| `[` `]` | folders: how many folder levels; files/functions: rings around the focus |
| `u` | scope one folder up |
| `g` | Graph: near the focus ⇄ everything. Files: graph this folder |
| `o` | show nodes with no links |
| `p` | pixels ⇄ braille text |
| `enter` | Graph: open a focused folder, or show the file in Files. Files: open folder, or show the file in the graph |
| `esc` | clear the focus, then scope up |
| `r` | rescan |

Changes tab:

| Key | Does |
|---|---|
| `↑` `↓` / `j` `k`, click | pick a file |
| `J` `K`, `pgup` `pgdn`, wheel | scroll the diff |
| `space` (or click its ●) | mark reviewed and go to the next |
| `n` / `a` | next unreviewed / mark all reviewed |
| `enter` | show the file in the graph |

The Changes tab only reads: it never stages, commits or discards, and it runs git with `--no-optional-locks` so it can't block the agent's own git calls.

## How it works

`git ls-files`, then regexes, no parser and no dependencies:

- **Imports**: JS/TS (relative, `.js` meaning `.ts`, `@/` and `~/` aliases, workspace packages by their `package.json` name) and Python (absolute and relative). Other languages get function nodes only.
- **Calls**: a defined function name followed by `(` inside another function. A name resolves to the same file, then to files it imports, then to a name defined once in the repo; anything else is skipped as ambiguous.
- **Layout**: a force layout (Fruchterman–Reingold, with hub-weighted links and a near-range repulsion like d3-force) that starts from the last positions, so a new focus moves calmly. The picture is painted in the mod (RGBA, transparent background), written to a temp file the terminal reads itself (so the drawing tree carries a path, not megabytes), and shown with Claude Code's `Image` element; pointer moves, drags and wheel turns redraw at most every 40 ms; labels are absolutely positioned text over it, and an empty client box on top catches the pointer. The whole-repo view keeps the 350 best-connected nodes.

It misses what regexes miss: dynamic dispatch, calls through objects passed around, re-exports by name. Treat it as a map, not a proof.

## Test

```sh
claude plugin test .
```

## License

MIT
