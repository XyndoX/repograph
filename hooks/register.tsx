import type { EngineInterface, Register } from 'claude-code'
import { build, CODE, type Graph, type Node } from './scan'
import { layout, nearest, raster, type Pos, type Seg } from './layout'
import { treeRows, type Row } from './tree'
import { type Change, diffRows, readChanges, readDiff, stamp, STATUS_COLOR } from './changes'
import type { CanvasProps } from './canvas'

const PANE = 'repograph'
const MAX_FILES = 4000
const MAX_BYTES = 400_000
const GLOBAL_CAP = 350 // the global graph keeps the best-connected nodes
const POLL_MS = 2500 // the Changes tab rereads git this often, to show edits while the agent works
const PALETTE = ['#a882ff', '#53dfdd', '#e5c07b', '#98c379', '#e06c75', '#61afef', '#d19a66', '#c678dd', '#56b6c2', '#ff79c6']
const C = { fg: '#dadada', muted: '#6b6b6b', edge: '#4a4a52', hot: '#a882ff', dim: '#3a3a3a', touched: '#f5a623', sel: '#2e2a3d', ok: '#98c379' }

type Tab = 'files' | 'graph' | 'changes'
type Mode = 'files' | 'functions'

const S = {
  root: '',
  files: [] as string[],
  graph: null as Graph | null,
  scanning: false,
  stale: false,
  error: '',
  tab: 'graph' as Tab,
  mode: 'files' as Mode,
  focus: '',
  center: '',
  local: false,
  orphans: false,
  depth: 1,
  view: { cx: 0.5, cy: 0.5, z: 1 },
  expanded: new Set<string>(),
  cursor: '',
  top: 0,
  touched: new Set<string>(),
  hits: [] as { id: string; x: number; y: number }[],
  tree: [] as Row[],
  canvas: { cols: 60, rows: 20 },
  // Changes tab
  changes: [] as Change[],
  sel: '',
  listTop: 0,
  listRows: 5,
  diff: [] as Seg[][],
  diffText: '',
  diffTop: 0,
  reviewed: new Map<string, string>(), // path → stamp when reviewed; a new edit clears it
  reading: false,
  poll: null as { cancel: () => void } | null,
}
let cache = { key: '', pos: new Map() as Pos }
const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

async function topOf($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const r = await $.process.run(['git', '--no-optional-locks', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })
  if (r.exitCode !== 0) throw new Error('not a git repo: repograph reads git')
  return r.stdout.trim()
}

async function scan($: EngineInterface) {
  if (S.scanning) return
  S.scanning = true
  S.error = ''
  redraw($)
  try {
    const root = await topOf($)
    const ls = await $.process.run(['git', '--no-optional-locks', '-C', root, 'ls-files', '-z'], { timeoutMs: 15_000 })
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
    if (root !== S.root) Object.assign(S, { focus: '', cursor: '', top: 0, expanded: new Set<string>(), view: { cx: 0.5, cy: 0.5, z: 1 }, sel: '', reviewed: new Map() })
    S.root = root
    S.files = all
    S.graph = build(texts)
    S.stale = false
    cache = { key: '', pos: new Map() }
  } catch (err) {
    S.error = err instanceof Error ? err.message : String(err)
  } finally {
    S.scanning = false
    redraw($)
  }
  void refreshChanges($)
}

async function refreshChanges($: EngineInterface) {
  if (S.reading || !S.root) return
  S.reading = true
  try {
    const run = (argv: string[], o: { timeoutMs: number }) => $.process.run(argv, o)
    const list = await readChanges(run, S.root)
    if (!list) return
    for (const [path, st] of S.reviewed) {
      const c = list.find(x => x.path === path)
      if (!c || stamp(c) !== st) S.reviewed.delete(path)
    }
    S.changes = list
    if (!list.some(c => c.path === S.sel)) { S.sel = list[0]?.path ?? ''; S.diffTop = 0 }
    const cur = list.find(c => c.path === S.sel)
    const text = cur ? await readDiff(run, S.root, cur) : ''
    if (text !== S.diffText) { S.diffText = text; S.diff = diffRows(text, S.canvas.cols) }
  } catch { /* git busy or gone: try again on the next tick */ } finally {
    S.reading = false
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
  return { nodes: ids.map(id => byId.get(id)!), edges: edges.filter(([a, b]) => shown.has(a) && shown.has(b)), near, seeds, deg, hidden }
}

const groupsOf = (g: Graph) => [...new Set(g.files.map(n => n.group))].sort()
const groupColor = (groups: string[]) => (group: string) => PALETTE[Math.max(0, groups.indexOf(group)) % PALETTE.length]!

function drawGraph(g: Graph, cols: number, rows: number) {
  const v = visible(g)
  const key = `${S.mode}|${S.local}|${S.orphans}|${S.depth}|${S.local ? S.focus : ''}|${v.nodes.length}|${v.edges.length}`
  if (cache.key !== key) cache = { key, pos: layout(v.nodes.map(n => n.id), v.edges) }
  // A focus picked from Files, search or Changes: bring it to the middle.
  if (S.center) {
    const id = cache.pos.has(S.center) ? S.center : v.seeds.find(s => cache.pos.has(s))
    const p = id ? cache.pos.get(id) : undefined
    if (p) S.view = { ...S.view, cx: p[0], cy: p[1] }
    S.center = ''
  }
  const color = groupColor(groupsOf(g))
  const byId = new Map(v.nodes.map(n => [n.id, n]))
  const focusId = v.seeds.length === 1 ? v.seeds[0]! : ''
  const ranked = [...v.nodes].sort((a, b) => v.deg(b.id) - v.deg(a.id))
  const big = new Set(ranked.slice(0, Math.max(3, Math.round(ranked.length / 12))).map(n => n.id))
  const labels = [...v.seeds, ...(S.focus ? [...v.near].filter(id => !v.seeds.includes(id)) : []), ...ranked.map(n => n.id)].filter((id, i, a) => a.indexOf(id) === i)
  const tint = (n: Node) => (S.touched.has(n.file) ? C.touched : color(n.group))
  const out = raster(
    { pos: cache.pos, edges: v.edges, focus: focusId, near: v.near, labels: labels.slice(0, S.focus ? 40 : 18), names: new Map(v.nodes.map(n => [n.id, n.label])), big },
    cols,
    rows,
    S.view,
    { color: id => tint(byId.get(id)!), edge: C.edge, hot: C.hot, dim: C.dim, label: C.fg },
  )
  S.hits = out.hits
  return { rows: out.rows, v }
}

function setFocus(id: string, center = false) {
  S.focus = id
  if (center) S.center = id
  if (S.local) cache.key = ''
}

function showInGraph(file: string) {
  if (!S.graph?.files.some(f => f.id === file)) return false
  setFocus(file, true)
  S.tab = 'graph'
  return true
}

function revealInTree(file: string) {
  const parts = file.split('/')
  for (let i = 1; i < parts.length; i++) S.expanded.add(parts.slice(0, i).join('/'))
  S.cursor = file
}

// Search: an exact name first, then a name that starts with it, then any path that holds it.
function find(q: string) {
  const g = S.graph
  const s = q.trim().toLowerCase()
  if (!g || !s) return
  const nodes = S.mode === 'files' ? g.files : g.fns
  const hit =
    nodes.find(n => n.label.toLowerCase() === s) ??
    nodes.find(n => n.label.toLowerCase().startsWith(s)) ??
    nodes.find(n => n.id.toLowerCase().includes(s))
  if (hit) setFocus(hit.id, true)
}

function selectChange(d: number) {
  const at = S.changes.findIndex(c => c.path === S.sel)
  const next = S.changes[Math.max(0, Math.min(S.changes.length - 1, at + d))]
  if (next && next.path !== S.sel) { S.sel = next.path; S.diffTop = 0; S.diffText = ''; S.diff = [] }
}

function toggleReviewed(path: string) {
  const c = S.changes.find(x => x.path === path)
  if (!c) return
  if (S.reviewed.has(path)) S.reviewed.delete(path)
  else S.reviewed.set(path, stamp(c))
}

async function key($: EngineInterface, k: string) {
  if (k === 'space') k = ' '
  if (k === '1') S.tab = 'files'
  else if (k === '2') S.tab = 'graph'
  else if (k === '3') { S.tab = 'changes'; void refreshChanges($) }
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
    else if (k === 'm') { S.mode = S.mode === 'files' ? 'functions' : 'files'; S.view = { cx: 0.5, cy: 0.5, z: 1 }; if (S.focus) S.center = S.focus.split('#')[0]! }
    else if (k === 'g') { S.local = !S.local; S.view = { cx: 0.5, cy: 0.5, z: S.view.z }; if (S.focus) S.center = S.focus }
    else if (k === 'o') S.orphans = !S.orphans
    else if (k === 'd') S.depth = S.depth === 1 ? 2 : 1
    else if (k === 'escape') S.focus = ''
    else if (k === 'return' && S.focus) { revealInTree(S.focus.split('#')[0]!); S.tab = 'files' }
    else return
  } else if (S.tab === 'changes') {
    const page = Math.max(1, S.canvas.rows - S.listRows - 2)
    if (k === 'up' || k === 'k') selectChange(-1)
    else if (k === 'down' || k === 'j') selectChange(1)
    else if (k === 'K') S.diffTop = Math.max(0, S.diffTop - 3)
    else if (k === 'J') S.diffTop += 3
    else if (k === 'pageup') S.diffTop = Math.max(0, S.diffTop - page)
    else if (k === 'pagedown' || k === 'f') S.diffTop += page
    else if (k === 'home') S.diffTop = 0
    else if (k === ' ') { toggleReviewed(S.sel); selectChange(1) }
    else if (k === 'n') {
      const at = S.changes.findIndex(c => c.path === S.sel)
      const next = [...S.changes.slice(at + 1), ...S.changes.slice(0, at + 1)].find(c => !S.reviewed.has(c.path))
      if (next) { S.sel = next.path; S.diffTop = 0; S.diffText = ''; S.diff = [] }
    } else if (k === 'a') for (const c of S.changes) S.reviewed.set(c.path, stamp(c))
    else if (k === 'return') { if (!showInGraph(S.sel)) { revealInTree(S.sel); S.tab = 'files' } }
    else return
    if (!S.diffText) void refreshChanges($)
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

function pressRow(row: Row) {
  S.cursor = row.id
  if (!row.dir) return void showInGraph(row.id)
  if (S.expanded.has(row.id)) S.expanded.delete(row.id)
  else S.expanded.add(row.id)
}

async function open($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Repo graph', focus: true, rows: 40, columns: 80 })
  S.poll ??= $.clock.every(POLL_MS, () => { if (S.tab === 'changes') void refreshChanges($) })
  let top = S.root
  try { top = await topOf($) } catch { /* scan reports it */ }
  if (!S.graph || S.stale || S.root !== top) void scan($)
  else void refreshChanges($)
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

function changeRows(cols: number, rows: number): Seg[][] {
  const at = Math.max(0, S.changes.findIndex(c => c.path === S.sel))
  if (at < S.listTop) S.listTop = at
  if (at >= S.listTop + rows) S.listTop = at - rows + 1
  S.listTop = Math.max(0, Math.min(S.listTop, Math.max(0, S.changes.length - rows)))
  return S.changes.slice(S.listTop, S.listTop + rows).map(c => {
    const bg = c.path === S.sel ? C.sel : undefined
    const done = S.reviewed.has(c.path)
    const counts = c.status === '?' ? (c.path.endsWith('/') ? ' folder' : ' new') : `${c.add ? ` +${c.add}` : ''}${c.del ? ` -${c.del}` : ''}`
    const room = Math.max(4, cols - 4 - counts.length - 1)
    const path = c.path.length > room ? '…' + c.path.slice(c.path.length - room + 1) : c.path
    const pad = ' '.repeat(Math.max(0, cols - 4 - path.length - counts.length))
    const segs: Seg[] = [
      { t: done ? '✓ ' : '● ', c: done ? C.ok : C.touched },
      { t: `${c.status} `, c: STATUS_COLOR[c.status] ?? C.fg, b: true },
      { t: path, c: done ? C.muted : C.fg },
      { t: pad },
      { t: counts, c: C.muted },
    ]
    return segs.filter(s => s.t).map(s => (bg ? { ...s, bg } : s))
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'repograph', description: 'Repo graph: files, dependencies and changes side by side; args: [files|functions|changes]' })
    return r
  })

  on('command.run', { command: 'repograph' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'functions' || arg === 'files') { S.mode = arg; S.tab = 'graph' }
    if (arg === 'changes') S.tab = 'changes'
    await open($)
    return { text: 'Repo graph: 1 files · 2 graph · 3 changes. Click the pane to give it the keys.' }
  })

  // Claude's edits light the file up, refresh the Changes tab, and mark the graph for a rescan.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
      if (path && S.root && path.startsWith(S.root + '/') && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'MultiEdit')) {
        S.touched.add(path.slice(S.root.length + 1))
        S.stale = true
      }
      if (S.root && (path || e.tool === 'Bash')) $.clock.after(300, () => void refreshChanges($))
      redraw($)
    } catch { /* the pane must never break a tool call */ }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && S.stale && S.graph) void scan($)
    return r
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !['canvas', 'list', 'diff'].includes(String(e.element)) || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { key?: string; click?: [number, number]; drag?: [number, number] }
    if (typeof data.key === 'string') await key($, data.key)
    else if (data.click && e.element === 'list') {
      const c = S.changes[S.listTop + data.click[1]]
      if (c && c.path === S.sel && data.click[0] < 2) toggleReviewed(c.path)
      else if (c) { S.sel = c.path; S.diffTop = 0; S.diffText = ''; S.diff = []; void refreshChanges($) }
      redraw($)
    } else if (data.click && S.tab === 'graph') {
      const id = nearest(S.hits, data.click[0], data.click[1])
      setFocus(id === S.focus ? '' : id)
      redraw($)
    } else if (data.click && S.tab === 'files') {
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
    else if (S.tab === 'changes') S.diffTop = Math.max(0, S.diffTop + Math.sign(e.by) * 3)
    else S.top = Math.max(0, S.top + Math.sign(e.by) * 3)
    redraw($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
    const cols = Math.max(30, (e.props?.bodyColumns ?? 80) - 1)
    const height = Math.max(12, e.props?.scroll?.bodyRows ?? 36)
    const g = S.graph
    const open = S.changes.filter(c => !S.reviewed.has(c.path)).length
    const tab = (id: Tab, label: string) => (
      <Button key={`tab-${id}`} plain bold={S.tab === id} dimColor={S.tab !== id} label={S.tab === id ? `[ ${label} ]` : `  ${label}  `} onPress={() => void key($, id === 'files' ? '1' : id === 'graph' ? '2' : '3')} />
    )
    const header = (
      <Box flexDirection="row">
        {tab('files', 'Files')}
        {tab('graph', 'Graph')}
        {tab('changes', S.changes.length ? `Changes ${open}/${S.changes.length}` : 'Changes')}
        <Box flexGrow={1} />
        {S.tab === 'graph' && <Button key="mode" plain dimColor label={S.mode === 'files' ? 'files ⇄' : 'functions ⇄'} onPress={() => void key($, 'm')} />}
        {S.tab === 'graph' && <Text> </Text>}
        {S.tab === 'graph' && <Button key="local" plain dimColor={!S.local} label={S.local ? `local·${S.depth}` : 'global'} onPress={() => void key($, 'g')} />}
        <Text> </Text>
        <Button key="rescan" plain dimColor label={S.scanning ? '…' : '↻'} onPress={() => void scan($)} />
      </Box>
    )
    const frame = (...body: unknown[]) => (
      <Box flexDirection="column" minHeight={height}>
        {header}
        {body}
      </Box>
    )
    if (!g) {
      return frame(
        <Text color={S.error ? 'red' : C.muted}>{S.error || (S.scanning ? 'Scanning the repo…' : 'Press r to scan.')}</Text>,
        <Client key="canvas" module="./canvas.tsx" props={{ rows: [] } satisfies CanvasProps} />,
      )
    }

    if (S.tab === 'files') {
      const rows = Math.max(4, height - 2)
      S.canvas = { cols, rows }
      const groups = groupsOf(g)
      const t = treeRows(S.files, g.fileEdges, S, groupColor(groups), C, cols, rows)
      S.tree = t.list
      return frame(
        <Client key="canvas" module="./canvas.tsx" props={{ rows: t.rows } satisfies CanvasProps} />,
        <Box flexGrow={1} />,
        <Text color={C.muted} wrap="truncate-end">{`${S.files.length} files · ←used by →imports · enter: show in graph`}</Text>,
      )
    }

    if (S.tab === 'changes') {
      S.listRows = Math.max(1, Math.min(S.changes.length, Math.max(3, Math.floor((height - 4) / 3))))
      const diffRowsN = Math.max(3, height - 3 - S.listRows)
      S.canvas = { cols, rows: height - 1 }
      if (!S.changes.length) {
        return frame(<Text color={C.muted}>{S.reading ? 'Reading git…' : 'No changes since the last commit.'}</Text>, <Box flexGrow={1} />, <Text color={C.muted}>{`watching git every ${POLL_MS / 1000}s`}</Text>)
      }
      S.diffTop = Math.max(0, Math.min(S.diffTop, Math.max(0, S.diff.length - diffRowsN)))
      const cur = S.changes.find(c => c.path === S.sel)
      const shown = S.diff.slice(S.diffTop, S.diffTop + diffRowsN)
      const where = S.diff.length > diffRowsN ? ` ${S.diffTop + 1}-${Math.min(S.diff.length, S.diffTop + diffRowsN)}/${S.diff.length}` : ''
      return frame(
        <Client key="list" module="./canvas.tsx" props={{ rows: changeRows(cols, S.listRows) } satisfies CanvasProps} />,
        <Box flexDirection="row">
          <Text color={C.hot} bold wrap="truncate-start">{`─ ${cur?.path ?? ''} `}</Text>
          <Box flexGrow={1} />
          <Text color={C.muted}>{where}</Text>
        </Box>,
        <Client key="diff" module="./canvas.tsx" props={{ rows: shown.length ? shown : [[{ t: S.reading ? 'loading…' : '(no line changes)', c: C.muted }]] } satisfies CanvasProps} />,
        <Box flexGrow={1} />,
        <Text color={C.muted} wrap="truncate-end">↑↓ file · J/K, pgup/pgdn, wheel: scroll · space reviewed · n next open · a all · enter: graph</Text>,
      )
    }

    const rows = Math.max(6, height - 6)
    S.canvas = { cols, rows }
    const { rows: canvas, v } = drawGraph(g, cols, rows)
    const edges = S.mode === 'files' ? g.fileEdges : g.fnEdges
    const uniq = (ids: string[]) => [...new Set(ids)]
    const out = uniq(v.seeds.flatMap(s => edges.filter(([a]) => a === s).map(([, b]) => b)).filter(id => !v.seeds.includes(id)))
    const inn = uniq(v.seeds.flatMap(s => edges.filter(([, b]) => b === s).map(([a]) => a)).filter(id => !v.seeds.includes(id)))
    const focusNode = [...g.files, ...g.fns].find(n => n.id === S.focus)
    const groups = groupsOf(g)
    const color = groupColor(groups)
    const legend = (
      <Box flexDirection="row" overflow="hidden" height={1}>
        {groups.slice(0, 10).map(gr => (
          <Text color={color(gr)}>{`■ ${gr}  `}</Text>
        ))}
      </Box>
    )
    const lines = S.focus
      ? [
          <Text bold color={C.hot} wrap="truncate-start">{focusNode ? (S.mode === 'files' ? focusNode.id : `${focusNode.label}()  ${focusNode.file}`) : S.focus}</Text>,
          <Text color={C.fg} wrap="truncate-end">{`${S.mode === 'files' ? 'imports' : 'calls'} (${out.length}): ${names(out, g, cols)}`}</Text>,
          <Text color={C.fg} wrap="truncate-end">{`${S.mode === 'files' ? 'used by' : 'called by'} (${inn.length}): ${names(inn, g, cols)}`}</Text>,
        ]
      : [
          <Text color={C.fg} wrap="truncate-end">{`${v.nodes.length} ${S.mode === 'files' ? 'files' : 'functions'} · ${v.edges.length} links${v.hidden ? ` · ${v.hidden} unlinked hidden (o)` : ''}${(S.mode === 'files' ? g.files : g.fns).length - v.hidden > v.nodes.length ? ` · top ${v.nodes.length} by links` : ''}`}</Text>,
          <Text color={C.muted} wrap="truncate-end">{`hubs: ${names([...v.nodes].sort((a, b) => v.deg(b.id) - v.deg(a.id)).slice(0, 5).map(n => n.id), g, cols)}`}</Text>,
          legend,
        ]
    return frame(
      <Input key="find" label="/ " placeholder={S.mode === 'files' ? 'find a file' : 'find a function'} submitLabel="focus" value="" onSubmit={(q: string) => { find(q); redraw($) }} />,
      <Client key="canvas" module="./canvas.tsx" props={{ rows: canvas } satisfies CanvasProps} />,
      ...lines,
      <Box flexGrow={1} />,
      <Text color={C.muted} wrap="truncate-end">click node · drag · wheel/± zoom · 0 reset · m mode · g local · d depth · o unlinked · enter: files · esc</Text>,
    )
  })
}
