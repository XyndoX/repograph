# repograph

A Claude Code mod that puts an Obsidian-style graph of your repo in a side pane, with a Files tab next to it.

- **Graph tab**: every code file as a dot, every import as a line, coloured by top-level folder. Press `m` to switch to **functions**: every function as a dot, every call as a line.
- **Files tab**: the repo's folders with link counts per file (`←` used by, `→` imports). Enter on a file shows it in the graph.
- Click a node to focus it: its links light up, everything else fades, and the bottom lines list what it imports and what uses it. `g` switches to the local graph (only the focus and its neighbours), `d` toggles depth 1 or 2.
- Files Claude edits turn orange, and the graph rescans after the turn.

## Install

```text
claude plugin marketplace add XyndoX/repograph
claude plugin install repograph@repograph --scope user
```

Then `/tui fullscreen` (the pane docks to the right) and `/repograph` (or `/repograph functions`).

## Keys

| Key | Does |
|---|---|
| `1` / `2` | Files tab / Graph tab |
| click, drag, scroll | focus a node, pan, zoom |
| arrows, `+` `-`, `0` | pan, zoom, reset the view |
| `m` | files ⇄ functions |
| `g`, `d` | local graph, depth 1/2 |
| `o` | show files with no links |
| `enter` | graph: show the focus in Files. Files: open folder, or show the file in the graph |
| `esc` | clear the focus |
| `r` | rescan |

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
