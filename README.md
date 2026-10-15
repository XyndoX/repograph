# repograph

A Claude Code mod that puts your repo in a side pane with three tabs: **Files**, an Obsidian-style **Graph** of its dependencies, and a lazygit-style **Changes** view to review what your agent is editing while it works.

- **Graph tab**: every code file as a dot, every import as a line, coloured by top-level folder. Press `m` to switch to **functions**: every function as a dot, every call as a line.
- **Files tab**: the repo's folders with link counts per file (`←` used by, `→` imports). Enter on a file shows it in the graph.
- Click a node to focus it: its links light up, everything else fades, and the bottom lines list what it imports and what uses it. `g` switches to the local graph (only the focus and its neighbours), `d` toggles depth 1 or 2.
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
| click, drag, scroll | focus a node, pan, zoom |
| arrows, `+` `-`, `0` | pan, zoom, reset the view |
| `m` | files ⇄ functions |
| `g`, `d` | local graph, depth 1/2 |
| `o` | show files with no links |
| `enter` | graph: show the focus in Files. Files: open folder, or show the file in the graph |
| `esc` | clear the focus |
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
- **Layout**: a force layout (Fruchterman–Reingold, with hub-weighted links and a near-range repulsion like d3-force), drawn with braille dots. The global view keeps the 350 best-connected nodes.

It misses what regexes miss: dynamic dispatch, calls through objects passed around, re-exports by name. Treat it as a map, not a proof.

## Test

```sh
claude plugin test .
```

## License

MIT
