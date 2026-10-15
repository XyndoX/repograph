import type { EngineInterface, Register } from 'claude-code'
import { build, CODE, type Graph, type Node } from './scan'
import { layout, nearest, raster, type Pos, type Seg } from './layout'
import type { CanvasProps } from './canvas'

const PANE = 'repograph'
const MAX_FILES = 4000
const MAX_BYTES = 400_000
const GLOBAL_CAP = 350 // the global graph keeps the best-connected nodes
const PALETTE = ['#a882ff', '#53dfdd', '#e5c07b', '#98c379', '#e06c75', '#61afef', '#d19a66', '#c678dd', '#56b6c2', '#ff79c6']
const C = { fg: '#dadada', muted: '#6b6b6b', edge: '#4a4a52', hot: '#a882ff', dim: '#3a3a3a', touched: '#f5a623', sel: '#2e2a3d' }

type Tab = 'files' | 'graph'
type Mode = 'files' | 'functions'

const S = {
  root: '',
  graph: null as Graph | null,
  scanning: false,
  stale: false,
  error: '',
  tab: 'graph' as Tab,
  mode: 'files' as Mode,
  focus: '',
  local: false,
  orphans: false,
  depth: 1,
  view: { cx: 0.5, cy: 0.5, z: 1 },
  expanded: new Set<string>(),
  cursor: '',
  top: 0,
  touched: new Set<string>(),
  hits: [] as { id: string; x: number; y: number }[],
  tree: [] as { id: string; dir: boolean }[],
  canvas: { cols: 60, rows: 20 },
}
let cache = { key: '', pos: new Map() as Pos }

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

async function scan($: EngineInterface) {
  if (S.scanning) return
  S.scanning = true
  S.error = ''
  redraw($)
  try {
    const root = await $.session.cwd()
    const ls = await $.process.run(['git', '-C', root, 'ls-files', '-z'], { timeoutMs: 15_000 })
    if (ls.exitCode !== 0) throw new Error('not a git repo: repograph reads `git ls-files`')
    const all = ls.stdout.split('\0').filter(Boolean)
    const wanted = all.filter(f => CODE.test(f) || f.endsWith('package.json')).slice(0, MAX_FILES)
    const texts: Record<string, string> = {}
    await Promise.all(
      wanted.map(async f => {
        try {
          const t = String(await $.fs.read(`${root}/${f}`))
          if (t.length <= MAX_BYTES) texts[f] = t
        } catch { /* deleted or unreadable: skip */ }
      }),
    )
    if (root !== S.root) Object.assign(S, { focus: '', cursor: '', top: 0, expanded: new Set<string>(), view: { cx: 0.5, cy: 0.5, z: 1 } })
    S.root = root
    S.graph = build(texts)
    S.tree = []
    S.stale = false
    cache = { key: '', pos: new Map() }
  } catch (err) {
    S.error = err instanceof Error ? err.message : String(err)
  } finally {
    S.scanning = false
    redraw($)
  }
}

// What the graph tab shows right now: nodes, edges, and who is near the focus.
function visible(g: Graph) {
  const nodes = S.mode === 'files' ? g.files : g.fns
  const edges = S.mode === 'files' ? g.fileEdges : g.fnEdges
  const byId = new Map(nodes.map(n => [n.id, n]))
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => adj.set(a, (adj.get(a) ?? new Set()).add(b))
  for (const [a, b] of edges) { link(a, b); link(b, a) }
  // In functions mode a file focus stands for all of its functions.
  const seeds = !S.focus ? [] : byId.has(S.focus) ? [S.focus] : nodes.filter(n => n.file === S.focus).map(n => n.id)
  const near = new Set(seeds)
  let ring = seeds
  for (let d = 0; d < S.depth; d++) {
    ring = ring.flatMap(id => [...(adj.get(id) ?? [])]).filter(id => !near.has(id))
    for (const id of ring) near.add(id)
  }
  const deg = (id: string) => adj.get(id)?.size ?? 0
  let ids: string[]
  if (S.local && seeds.length) ids = [...near]
  else {
    ids = nodes.map(n => n.id).filter(id => S.orphans || deg(id) > 0 || near.has(id))
    if (ids.length > GLOBAL_CAP) {
      const keep = new Set([...ids].sort((a, b) => deg(b) - deg(a)).slice(0, GLOBAL_CAP))
      for (const id of near) keep.add(id)
      ids = ids.filter(id => keep.has(id))
    }
  }
  const shown = new Set(ids)
  const hidden = S.local && seeds.length ? 0 : nodes.filter(n => !S.orphans && deg(n.id) === 0 && !near.has(n.id)).length
  return { nodes: ids.map(id => byId.get(id)!), edges: edges.filter(([a, b]) => shown.has(a) && shown.has(b)), near, seeds, adj, deg, hidden }
}

function colorOf(groups: string[]) {
  return (n: Node) => (S.touched.has(n.file) ? C.touched : PALETTE[Math.max(0, groups.indexOf(n.group)) % PALETTE.length]!)
}

function drawGraph(g: Graph, cols: number, rows: number) {
  const v = visible(g)
  const key = `${S.mode}|${S.local}|${S.orphans}|${S.depth}|${S.local ? S.focus : ''}|${v.nodes.length}|${v.edges.length}`
  if (cache.key !== key) cache = { key, pos: layout(v.nodes.map(n => n.id), v.edges) }
  const groups = [...new Set(g.files.map(n => n.group))].sort()
  const color = colorOf(groups)
  const byId = new Map(v.nodes.map(n => [n.id, n]))
  const focusId = v.seeds.length === 1 ? v.seeds[0]! : ''
  const ranked = [...v.nodes].sort((a, b) => v.deg(b.id) - v.deg(a.id))
  const big = new Set(ranked.slice(0, Math.max(3, Math.round(ranked.length / 12))).map(n => n.id))
  const labels = [...v.seeds, ...(S.focus ? [...v.near].filter(id => !v.seeds.includes(id)) : []), ...ranked.map(n => n.id)].filter((id, i, a) => a.indexOf(id) === i)
  const out = raster(
    {
      pos: cache.pos,
      edges: v.edges,
      focus: focusId,
      near: v.near,
      labels: labels.slice(0, S.focus ? 40 : 18),
      names: new Map(v.nodes.map(n => [n.id, n.label])),
      big,
    },
    cols,
    rows,
    S.view,
    { color: id => color(byId.get(id)!), edge: C.edge, hot: C.hot, dim: C.dim, label: C.fg },
  )
  S.hits = out.hits
  return { rows: out.rows, v }
}

// The Files tab: the repo's folders, collapsed, with link counts per file.
function treeRows(g: Graph, cols: number, rows: number): Seg[][] {
  const files = g.files.map(f => f.id)
  const ins = new Map<string, number>()
  const outs = new Map<string, number>()
  for (const [a, b] of g.fileEdges) { outs.set(a, (outs.get(a) ?? 0) + 1); ins.set(b, (ins.get(b) ?? 0) + 1) }
  const kids = new Map<string, Set<string>>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      kids.set(parent, (kids.get(parent) ?? new Set()).add(parts.slice(0, i + 1).join('/')))
    }
  }
  const isDir = (id: string) => kids.has(id)
  const list: { id: string; depth: number }[] = []
  const walk = (dir: string, depth: number) => {
    const sorted = [...(kids.get(dir) ?? [])].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.localeCompare(b))
    for (const id of sorted) {
      list.push({ id, depth })
      if (isDir(id) && S.expanded.has(id)) walk(id, depth + 1)
    }
  }
  walk('', 0)
  S.tree = list.map(r => ({ id: r.id, dir: isDir(r.id) }))
  if (!S.cursor || !S.tree.some(r => r.id === S.cursor)) S.cursor = S.tree[0]?.id ?? ''
  const at = S.tree.findIndex(r => r.id === S.cursor)
  if (at < S.top) S.top = at
  if (at >= S.top + rows) S.top = at - rows + 1
  S.top = Math.max(0, Math.min(S.top, Math.max(0, list.length - rows)))
  const groups = [...new Set(g.files.map(n => n.group))].sort()
  return list.slice(S.top, S.top + rows).map(({ id, depth }) => {
    const dir = isDir(id)
    const name = id.split('/').pop()!
    const bg = id === S.cursor ? C.sel : undefined
    const counts = dir ? '' : `${ins.get(id) ? ` ←${ins.get(id)}` : ''}${outs.get(id) ? ` →${outs.get(id)}` : ''}`
    const left = `${'  '.repeat(depth)}${dir ? (S.expanded.has(id) ? '▾ ' : '▸ ') : '  '}`
    const room = Math.max(4, cols - left.length - counts.length - 2)
    const shown = name.length > room ? name.slice(0, room - 1) + '…' : name
    const group = id.split('/').length > 1 || dir ? id.split('/')[0]! : '.'
    const dot = dir ? '■ ' : '• '
    const color = S.touched.has(id) ? C.touched : PALETTE[Math.max(0, groups.indexOf(group)) % PALETTE.length]
    const pad = ' '.repeat(Math.max(0, cols - left.length - dot.length - shown.length - counts.length))
    return [
      { t: left, c: C.muted, bg },
      { t: dot, c: color, bg },
      { t: shown, c: id === S.focus ? C.hot : C.fg, b: id === S.focus, bg },
      { t: pad, bg },
      { t: counts, c: C.muted, bg },
    ]
      .filter(s => s.t)
      .map(s => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Seg)
  })
}

function setFocus(id: string) {
  S.focus = id
  if (S.local) cache.key = ''
}

function revealInTree(file: string) {
  const parts = file.split('/')
  for (let i = 1; i < parts.length; i++) S.expanded.add(parts.slice(0, i).join('/'))
  S.cursor = file
}

async function key($: EngineInterface, k: string) {
  if (k === '1') S.tab = 'files'
  else if (k === '2') S.tab = 'graph'
  else if (k === 'r') return void scan($)
  else if (S.tab === 'graph') {
    const step = 0.12 / S.view.z
    if (k === 'left') S.view.cx -= step
    else if (k === 'right') S.view.cx += step
    else if (k === 'up') S.view.cy -= step
    else if (k === 'down') S.view.cy += step
    else if (k === '+' || k === '=') S.view.z = Math.min(12, S.view.z * 1.25)
    else if (k === '-' || k === '_') S.view.z = Math.max(0.3, S.view.z / 1.25)
    else if (k === '0') S.view = { cx: 0.5, cy: 0.5, z: 1 }
    else if (k === 'm') { S.mode = S.mode === 'files' ? 'functions' : 'files'; S.view = { cx: 0.5, cy: 0.5, z: 1 } }
    else if (k === 'g') { S.local = !S.local; S.view = { cx: 0.5, cy: 0.5, z: 1 } }
    else if (k === 'o') S.orphans = !S.orphans
    else if (k === 'd') S.depth = S.depth === 1 ? 2 : 1
    else if (k === 'escape') S.focus = ''
    else if (k === 'return' && S.focus) { revealInTree(S.focus.split('#')[0]!); S.tab = 'files' }
    else return
  } else {
    const at = S.tree.findIndex(r => r.id === S.cursor)
    const row = S.tree[at]
    const move = (d: number) => { S.cursor = S.tree[Math.max(0, Math.min(S.tree.length - 1, at + d))]?.id ?? S.cursor }
    if (k === 'up' || k === 'k') move(-1)
    else if (k === 'down' || k === 'j') move(1)
    else if (k === 'pageup') move(-S.canvas.rows)
    else if (k === 'pagedown') move(S.canvas.rows)
    else if (!row) return
    else if (k === 'right' || k === 'l') { if (row.dir) S.expanded.add(row.id) }
    else if (k === 'left' || k === 'h') {
      if (row.dir && S.expanded.has(row.id)) S.expanded.delete(row.id)
      else if (row.id.includes('/')) S.cursor = row.id.slice(0, row.id.lastIndexOf('/'))
    } else if (k === 'return' || k === ' ') pressRow(row)
    else return
  }
  redraw($)
}

function pressRow(row: { id: string; dir: boolean }) {
  S.cursor = row.id
  if (row.dir) {
    if (S.expanded.has(row.id)) S.expanded.delete(row.id)
    else S.expanded.add(row.id)
  } else {
    setFocus(row.id)
    S.tab = 'graph'
  }
}

async function open($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Repo graph', focus: true, rows: 40, columns: 80 })
  if (!S.graph || S.stale || S.root !== (await $.session.cwd())) void scan($)
}

function names(ids: string[], g: Graph, width: number): string {
  const label = new Map([...g.files, ...g.fns].map(n => [n.id, S.mode === 'files' ? n.id : n.label]))
  let out = ''
  for (const [i, id] of ids.entries()) {
    const next = (i ? ', ' : '') + (label.get(id) ?? id)
    if (out.length + next.length > width - 6) return `${out} +${ids.length - i}`
    out += next
  }
  return out || '—'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'repograph', description: 'Repo graph: files and dependencies side by side; args: [files|functions]' })
    return r
  })

  on('command.run', { command: 'repograph' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'functions' || arg === 'files') { S.mode = arg; S.tab = 'graph' }
    await open($)
    return { text: `Repo graph: ${S.mode} view. Keys: 1 files, 2 graph, m mode, g local, r rescan.` }
  })

  // Claude's edits light the file up and mark the graph for a rescan.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (path && S.root && path.startsWith(S.root + '/') && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'MultiEdit')) {
      S.touched.add(path.slice(S.root.length + 1))
      S.stale = true
      redraw($)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && S.stale && S.graph) void scan($)
    return r
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'canvas' || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { key?: string; click?: [number, number]; drag?: [number, number] }
    if (typeof data.key === 'string') await key($, data.key)
    else if (data.click && S.tab === 'graph') {
      const id = nearest(S.hits, data.click[0], data.click[1])
      setFocus(id === S.focus ? '' : id)
      redraw($)
    } else if (data.click) {
      const row = S.tree[S.top + data.click[1]]
      if (row) pressRow(row)
      redraw($)
    } else if (data.drag && S.tab === 'graph') {
      const scale = Math.min(S.canvas.cols * 2, S.canvas.rows * 4) * S.view.z
      S.view.cx -= (data.drag[0] * 2) / scale
      S.view.cy -= (data.drag[1] * 4) / scale
      redraw($)
    }
    return {}
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (S.tab === 'graph') S.view.z = Math.max(0.3, Math.min(12, S.view.z * (e.by < 0 ? 1.15 : 1 / 1.15)))
    else S.top = Math.max(0, S.top + Math.sign(e.by) * 3)
    redraw($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const cols = Math.max(30, (e.props?.bodyColumns ?? 80) - 1)
    const height = Math.max(12, e.props?.scroll?.bodyRows ?? 36)
    const g = S.graph
    const tab = (id: Tab, label: string) => (
      <Button key={`tab-${id}`} plain bold={S.tab === id} dimColor={S.tab !== id} label={S.tab === id ? `[ ${label} ]` : `  ${label}  `} onPress={() => { S.tab = id; redraw($) }} />
    )
    const header = (
      <Box flexDirection="row">
        {tab('files', 'Files')}
        {tab('graph', 'Graph')}
        <Box flexGrow={1} />
        {S.tab === 'graph' && <Button key="mode" plain dimColor label={S.mode === 'files' ? 'files ⇄' : 'functions ⇄'} onPress={() => void key($, 'm')} />}
        {S.tab === 'graph' && <Text> </Text>}
        {S.tab === 'graph' && <Button key="local" plain dimColor={!S.local} label={S.local ? `local·${S.depth}` : 'global'} onPress={() => void key($, 'g')} />}
        <Text> </Text>
        <Button key="rescan" plain dimColor label={S.scanning ? '…' : '↻'} onPress={() => void scan($)} />
      </Box>
    )
    if (!g) {
      return (
        <Box flexDirection="column">
          {header}
          <Text color={S.error ? 'red' : C.muted}>{S.error || (S.scanning ? 'Scanning the repo…' : 'Press r to scan.')}</Text>
          <Client key="canvas" module="./canvas.tsx" props={{ rows: [] } satisfies CanvasProps} />
        </Box>
      )
    }
    const info = S.tab === 'graph' ? 4 : 1
    const rows = Math.max(6, height - 1 - info)
    S.canvas = { cols, rows }
    if (S.tab === 'files') {
      return (
        <Box flexDirection="column">
          {header}
          <Client key="canvas" module="./canvas.tsx" props={{ rows: treeRows(g, cols, rows) } satisfies CanvasProps} />
          <Text color={C.muted} wrap="truncate-end">{`${g.files.length} files · ←used by →imports · enter: show in graph`}</Text>
        </Box>
      )
    }
    const { rows: canvas, v } = drawGraph(g, cols, rows)
    const edges = S.mode === 'files' ? g.fileEdges : g.fnEdges
    const out = v.seeds.flatMap(s => edges.filter(([a]) => a === s).map(([, b]) => b)).filter(id => !v.seeds.includes(id))
    const inn = v.seeds.flatMap(s => edges.filter(([, b]) => b === s).map(([a]) => a)).filter(id => !v.seeds.includes(id))
    const uniq = (ids: string[]) => [...new Set(ids)]
    const focusNode = [...g.files, ...g.fns].find(n => n.id === S.focus)
    const lines = S.focus
      ? [
          <Text bold color={C.hot} wrap="truncate-start">{focusNode ? (S.mode === 'files' ? focusNode.id : `${focusNode.label}()  ${focusNode.file}`) : S.focus}</Text>,
          <Text color={C.fg} wrap="truncate-end">{`${S.mode === 'files' ? 'imports' : 'calls'} (${uniq(out).length}): ${names(uniq(out), g, cols)}`}</Text>,
          <Text color={C.fg} wrap="truncate-end">{`${S.mode === 'files' ? 'used by' : 'called by'} (${uniq(inn).length}): ${names(uniq(inn), g, cols)}`}</Text>,
        ]
      : [
          <Text color={C.fg} wrap="truncate-end">{`${v.nodes.length} ${S.mode === 'files' ? 'files' : 'functions'} · ${v.edges.length} links${v.hidden ? ` · ${v.hidden} unlinked hidden (o)` : ''}${(S.mode === 'files' ? g.files : g.fns).length - v.hidden > v.nodes.length ? ` · top ${v.nodes.length} by links` : ''}`}</Text>,
          <Text color={C.muted} wrap="truncate-end">{`hubs: ${names([...v.nodes].sort((a, b) => v.deg(b.id) - v.deg(a.id)).slice(0, 5).map(n => n.id), g, cols)}`}</Text>,
          <Text> </Text>,
        ]
    return (
      <Box flexDirection="column">
        {header}
        <Client key="canvas" module="./canvas.tsx" props={{ rows: canvas } satisfies CanvasProps} />
        {lines}
        <Text color={C.muted} wrap="truncate-end">click node · drag · scroll/± zoom · 0 reset · m mode · g local · d depth · o unlinked · enter: in files · esc</Text>
      </Box>
    )
  })

}
