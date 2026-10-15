import type { EngineInterface, Register } from 'claude-code'
import { build, CODE, type Graph } from './scan'
import type { Seg } from './layout'
import { treeRows, type Row } from './tree'
import { type Change, diffRows, readChanges, readDiff, stamp, STATUS_COLOR } from './changes'
import { draw, IN, OUT, PALETTE, type Drawn } from './graph'
import { cellSize } from './paint'
import type { Mode } from './view'
import type { CanvasProps } from './canvas'
import type { OverlayProps } from './overlay'

const PANE = 'repograph'
const MAX_FILES = 4000
const MAX_BYTES = 400_000
const GLOBAL_CAP = 350 // the whole-repo graph keeps the best-connected nodes
const POLL_MS = 2500 // the Changes tab rereads git this often, to show edits while the agent works
const MODES: Mode[] = ['folders', 'files', 'functions']
const C = { fg: '#dadada', muted: '#6b6b6b', hot: '#a882ff', touched: '#f5a623', sel: '#2e2a3d', ok: '#98c379' }

type Tab = 'files' | 'graph' | 'changes'

const S = {
  root: '',
  files: [] as string[],
  graph: null as Graph | null,
  scanning: false,
  stale: false,
  error: '',
  tab: 'graph' as Tab,
  // Graph tab
  mode: 'files' as Mode,
  scope: '', // a folder: the graph shows what's inside, and what it links to outside
  focus: '',
  hover: '',
  local: true, // a focus narrows the graph to its neighbourhood
  orphans: false,
  depth: 1, // rings around a focus
  levels: 2, // folders mode: how deep the folder map splits
  pixels: true,
  cam: { cx: 0.5, cy: 0.5, z: 1 },
  center: '',
  pendingClear: false,
  drawn: null as Drawn | null,
  box: { cols: 60, rows: 20 },
  // Files tab
  expanded: new Set<string>(),
  cursor: '',
  top: 0,
  tree: [] as Row[],
  touched: new Set<string>(),
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
const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

// Pointer moves, drags and wheel turns come fast; draw at most every 40 ms.
let soonPending = false
function soon($: EngineInterface) {
  if (soonPending) return
  soonPending = true
  $.clock.after(40, () => { soonPending = false; redraw($) })
}

// The picture goes to the terminal as a file it reads itself, so the drawing
// tree carries a path, not megabytes of pixels. Two files take turns, so the
// terminal never reads one half-written.
const RUN_ID = Math.random().toString(36).slice(2, 8)
const pic = { key: '', ready: null as null | { file: string; width: number; height: number; generation: number }, gen: 0, inline: false }
async function ensurePicture($: EngineInterface, img: { rgba: string; width: number; height: number; key: string }) {
  if (pic.key === img.key || pic.inline) return
  pic.key = img.key
  const gen = pic.gen + 1
  try {
    const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/$/, '')
    const file = `${tmp}/repograph-${RUN_ID}-${gen % 2}.rgba`
    const r = await $.process.run(['/bin/sh', '-c', 'base64 -d > "$1"', 'sh', file], { stdin: img.rgba, timeoutMs: 10_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr)
    if (pic.key !== img.key) return // a newer picture is on its way
    pic.gen = gen
    pic.ready = { file, width: img.width, height: img.height, generation: gen }
  } catch {
    pic.inline = true // no shell to write with: send the pixels inline instead
  }
  redraw($)
}
const resetCam = () => { S.cam = { cx: 0.5, cy: 0.5, z: 1 } }

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
    const fresh = root !== S.root
    S.graph = build(texts)
    if (fresh) {
      Object.assign(S, { focus: '', scope: '', cursor: '', top: 0, expanded: new Set<string>(), sel: '', reviewed: new Map() })
      resetCam()
      // A big repo opens on its folders: a map first, the streets when you zoom in.
      S.mode = S.graph.files.length > 120 ? 'folders' : 'files'
    }
    S.root = root
    S.files = all
    S.stale = false
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
    if (text !== S.diffText) { S.diffText = text; S.diff = diffRows(text, S.box.cols) }
  } catch { /* git busy or gone: try again on the next tick */ } finally {
    S.reading = false
    redraw($)
  }
}

const groupsOf = (g: Graph) => [...new Set(g.files.map(n => n.group))].sort()
const groupColor = (groups: string[]) => (group: string) => PALETTE[Math.max(0, groups.indexOf(group)) % PALETTE.length]!

function setFocus(id: string, center = false) {
  S.focus = id
  if (center) S.center = id
}

// Scope the graph to a folder; '' is the whole repo.
function setScope(folder: string) {
  S.scope = folder.replace(/\/$/, '')
  S.focus = ''
  resetCam()
  // A folder with no subfolders has nothing to show as folders.
  if (S.mode === 'folders' && !S.files.some(f => f.startsWith(S.scope + '/') && f.slice(S.scope.length + 1).includes('/'))) S.mode = 'files'
}

function scopeUp() {
  if (!S.scope) return
  setScope(S.scope.includes('/') ? S.scope.slice(0, S.scope.lastIndexOf('/')) : '')
}

// Clicking a focused folder node (or one outside the scope) steps into it.
function open(id: string) {
  const n = S.drawn?.v.nodes.find(x => x.id === id)
  if (!n) return
  if (n.kind === 'folder') return setScope(n.id)
  if (n.kind === 'outside') {
    const isDir = S.files.some(f => f.startsWith(n.file + '/'))
    setScope(isDir ? n.file : n.file.includes('/') ? n.file.slice(0, n.file.lastIndexOf('/')) : '')
  }
}

function showInGraph(file: string) {
  if (!S.graph?.files.some(f => f.id === file)) return false
  if (S.scope && !file.startsWith(S.scope + '/')) setScope('')
  if (S.mode === 'folders') S.mode = 'files'
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
  const nodes = S.mode === 'functions' ? g.fns : g.files
  const hit =
    nodes.find(n => n.label.toLowerCase() === s) ??
    nodes.find(n => n.label.toLowerCase().startsWith(s)) ??
    nodes.find(n => n.id.toLowerCase().includes(s))
  if (!hit) return
  if (S.scope && !hit.file.startsWith(S.scope + '/')) setScope('')
  if (S.mode === 'folders') S.mode = 'files'
  setFocus(hit.id, true)
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
    const step = 0.12 / S.cam.z
    if (k === 'left') S.cam.cx -= step
    else if (k === 'right') S.cam.cx += step
    else if (k === 'up') S.cam.cy -= step
    else if (k === 'down') S.cam.cy += step
    else if (k === '+' || k === '=') S.cam.z = Math.min(12, S.cam.z * 1.25)
    else if (k === '-' || k === '_') S.cam.z = Math.max(0.3, S.cam.z / 1.25)
    else if (k === '0') resetCam()
    else if (k === 'm') { S.mode = MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]!; resetCam(); if (S.focus) S.center = S.focus.split('#')[0]! }
    else if (k === ']') { if (S.mode === 'folders') S.levels = Math.min(6, S.levels + 1); else S.depth = Math.min(5, S.depth + 1) }
    else if (k === '[') { if (S.mode === 'folders') S.levels = Math.max(1, S.levels - 1); else S.depth = Math.max(1, S.depth - 1) }
    else if (k === 'g') { S.local = !S.local; resetCam(); if (S.focus) S.center = S.focus }
    else if (k === 'o') S.orphans = !S.orphans
    else if (k === 'p') S.pixels = !S.pixels
    else if (k === 'u' || k === 'backspace') scopeUp()
    else if (k === 'escape') { if (S.focus) S.focus = ''; else scopeUp() }
    else if (k === 'return' && S.focus) {
      const n = S.drawn?.v.nodes.find(x => x.id === S.focus)
      if (n && (n.kind === 'folder' || n.kind === 'outside')) open(n.id)
      else { revealInTree(S.focus.split('#')[0]!); S.tab = 'files' }
    } else return
  } else if (S.tab === 'changes') {
    const page = Math.max(1, S.box.rows - S.listRows - 2)
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
    else if (k === 'pageup') move(-S.box.rows)
    else if (k === 'pagedown') move(S.box.rows)
    else if (!row) return
    else if (k === 'right' || k === 'l') { if (row.dir) S.expanded.add(row.id) }
    else if (k === 'left' || k === 'h') {
      if (row.dir && S.expanded.has(row.id)) S.expanded.delete(row.id)
      else if (row.id.includes('/')) S.cursor = row.id.slice(0, row.id.lastIndexOf('/'))
    } else if (k === 'g') { if (row.dir) { setScope(row.id); S.tab = 'graph' } else showInGraph(row.id) }
    else if (k === 'return' || k === ' ') pressRow(row)
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

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Repo graph', focus: true, rows: 40, columns: 80 })
  S.poll ??= $.clock.every(POLL_MS, () => { if (S.tab === 'changes') void refreshChanges($) })
  let top = S.root
  try { top = await topOf($) } catch { /* scan reports it */ }
  if (!S.graph || S.stale || S.root !== top) void scan($)
  else void refreshChanges($)
}

function names(ids: string[], label: (id: string) => string, width: number): string {
  let out = ''
  for (const [i, id] of ids.entries()) {
    const next = (i ? ', ' : '') + label(id)
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
    await $.command.register({ name: 'repograph', description: 'Repo graph: files, dependencies and changes side by side; args: [folders|files|functions|changes|<folder>]' })
    return r
  })

  on('command.run', { command: 'repograph' }, async ($, e) => {
    const arg = (e.args ?? '').trim().replace(/\/$/, '')
    await openPane($)
    if (arg === 'functions' || arg === 'files' || arg === 'folders') { S.mode = arg; S.tab = 'graph' }
    else if (arg === 'changes') S.tab = 'changes'
    else if (arg) { setScope(arg); S.tab = 'graph' }
    redraw($)
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
    if (e.requestId !== PANE || !['canvas', 'list', 'diff', 'graph'].includes(String(e.element)) || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { key?: string; press?: [number, number]; release?: boolean; click?: [number, number]; drag?: [number, number]; hover?: [number, number] | null }
    if (typeof data.key === 'string') await key($, data.key)
    else if (data.click && e.element === 'list') {
      const c = S.changes[S.listTop + Math.floor(data.click[1])]
      if (c && c.path === S.sel && data.click[0] < 2) toggleReviewed(c.path)
      else if (c) { S.sel = c.path; S.diffTop = 0; S.diffText = ''; S.diff = []; void refreshChanges($) }
      redraw($)
    } else if (data.press && S.tab === 'graph') {
      // A press on a node acts at once; a press on empty space clears the focus
      // only if it ends without a drag (a drag pans instead).
      const id = S.drawn?.hit(data.press[0], data.press[1]) ?? ''
      S.pendingClear = !id
      if (id && id === S.focus) open(id)
      else if (id) setFocus(id)
      redraw($)
    } else if (data.release && S.tab === 'graph') {
      if (S.pendingClear) { S.focus = ''; redraw($) }
      S.pendingClear = false
    } else if (data.click && S.tab === 'graph') {
      const id = S.drawn?.hit(data.click[0], data.click[1]) ?? ''
      if (id && id === S.focus) open(id)
      else setFocus(id)
      redraw($)
    } else if (data.click && S.tab === 'files') {
      const row = S.tree[S.top + Math.floor(data.click[1])]
      if (row) pressRow(row)
      redraw($)
    } else if (data.drag && S.tab === 'graph') {
      S.pendingClear = false
      const { cw, ch } = S.pixels ? cellSize(S.box.cols, S.box.rows) : { cw: 2, ch: 4 }
      const scale = Math.min(S.box.cols * cw, S.box.rows * ch) * (S.pixels ? 0.92 : 1) * S.cam.z
      S.cam.cx -= (data.drag[0] * cw) / scale
      S.cam.cy -= (data.drag[1] * ch) / scale
      soon($)
    } else if ('hover' in data && S.tab === 'graph') {
      const id = data.hover ? (S.drawn?.hit(data.hover[0], data.hover[1]) ?? '') : ''
      if (id !== S.hover) { S.hover = id; soon($) }
    }
    return {}
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (S.tab === 'graph') S.cam.z = Math.max(0.3, Math.min(12, S.cam.z * (e.by < 0 ? 1.06 : 1 / 1.06)))
    else if (S.tab === 'changes') S.diffTop = Math.max(0, S.diffTop + Math.sign(e.by) * 3)
    else S.top = Math.max(0, S.top + Math.sign(e.by) * 3)
    soon($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input, Client } = ui
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
      S.box = { cols, rows }
      const t = treeRows(S.files, g.fileEdges, S, groupColor(groupsOf(g)), C, cols, rows)
      S.tree = t.list
      return frame(
        <Client key="canvas" module="./canvas.tsx" props={{ rows: t.rows } satisfies CanvasProps} />,
        <Box flexGrow={1} />,
        <Text color={C.muted} wrap="truncate-end">{`${S.files.length} files · ←used by →imports · enter: open / show · g: graph this folder`}</Text>,
      )
    }

    if (S.tab === 'changes') {
      S.listRows = Math.max(1, Math.min(S.changes.length, Math.max(3, Math.floor((height - 4) / 3))))
      const diffRowsN = Math.max(3, height - 3 - S.listRows)
      S.box = { cols, rows: height - 1 }
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

    // Graph tab: the picture, labels laid over it as text, and an empty box over
    // both that catches the pointer.
    const rows = Math.max(6, height - 7)
    S.box = { cols, rows }
    const pixels = S.pixels && e.surface === 'terminal'
    const input = { mode: S.mode, scope: S.scope, focus: S.focus, depth: S.depth, levels: S.levels, local: S.local, orphans: S.orphans, cap: GLOBAL_CAP }
    let d = draw(g, input, S.cam, cols, rows, pixels, S.hover, S.touched)
    if (S.center) {
      const p = d.centre(S.center) ?? d.centre(d.v.seeds[0] ?? '')
      S.center = ''
      if (p) { S.cam.cx = p[0]; S.cam.cy = p[1]; d = draw(g, input, S.cam, cols, rows, pixels, S.hover, S.touched) }
    }
    S.drawn = d
    const v = d.v
    const nodeById = new Map(v.nodes.map(n => [n.id, n]))
    const label = (id: string) => {
      const n = nodeById.get(id)
      return !n ? id : n.kind === 'fn' ? `${n.label}()` : n.kind === 'outside' ? `${n.label} (outside)` : n.file
    }
    const words = S.mode === 'functions' ? ['calls', 'called by'] : ['imports', 'used by']
    const focusNode = nodeById.get(v.seeds[0] ?? '')
    const hovered = nodeById.get(S.hover)
    const Image = e.surface === 'terminal' ? ($.ui.resolve(e) as { Image?: (p: object) => unknown }).Image : undefined
    if (pixels && d.image) void ensurePicture($, d.image)
    const source = pic.inline && d.image ? { rgba: d.image.rgba, width: d.image.width, height: d.image.height } : pic.ready ? { ...pic.ready, format: 'rgba' as const } : null
    const picture =
      pixels && Image ? (
        source ? <Image key="graph-image" source={source} columns={cols} rows={rows} alt="repo graph" /> : <Box width={cols} height={rows} />
      ) : (
        <Client key="canvas" module="./canvas.tsx" props={{ rows: d.text ?? [] } satisfies CanvasProps} />
      )
    const crumbs = S.scope ? S.scope.split('/') : []
    const groups = groupsOf(g)
    const lines = S.focus
      ? [
          <Text bold color="#ffffff" wrap="truncate-start">{focusNode ? label(focusNode.id) : S.focus}</Text>,
          <Text color={OUT} wrap="truncate-end">{`→ ${words[0]} (${v.out.size}): ${names([...v.out], label, cols)}`}</Text>,
          <Text color={IN} wrap="truncate-end">{`← ${words[1]} (${v.inn.size}): ${names([...v.inn], label, cols)}`}</Text>,
        ]
      : [
          <Text color={hovered ? '#ffffff' : C.fg} wrap="truncate-end">
            {hovered ? label(hovered.id) : `${v.nodes.length} ${S.mode} · ${v.edges.length} links${v.hidden ? ` · ${v.hidden} unlinked hidden (o)` : ''}${v.total - v.hidden > v.nodes.length ? ` · top ${v.nodes.length}` : ''}`}
          </Text>,
          <Text color={C.muted} wrap="truncate-end">{`hubs: ${names([...v.nodes].filter(n => n.kind !== 'outside').sort((a, b) => v.deg(b.id) - v.deg(a.id)).slice(0, 5).map(n => n.id), label, cols)}`}</Text>,
          <Box flexDirection="row" overflow="hidden" height={1}>
            {groups.slice(0, 10).map(gr => (
              <Text color={groupColor(groups)(gr)}>{`● ${gr}  `}</Text>
            ))}
          </Box>,
        ]
    return frame(
      <Box flexDirection="row">
        <Button key="scope-root" plain dimColor={!!S.scope} bold={!S.scope} label="⌂ repo" onPress={() => { setScope(''); redraw($) }} />
        {crumbs.map((c, i) => (
          <Button key={`crumb-${i}`} plain dimColor={i < crumbs.length - 1} bold={i === crumbs.length - 1} label={` / ${c}`} onPress={() => { setScope(crumbs.slice(0, i + 1).join('/')); redraw($) }} />
        ))}
        <Box flexGrow={1} />
        <Button key="mode" plain dimColor label={`${S.mode} ⇄`} onPress={() => void key($, 'm')} />
        <Text> </Text>
        <Button key="depth-down" plain dimColor label="‹" onPress={() => void key($, '[')} />
        <Text color={C.fg}>{S.mode === 'folders' ? ` levels ${S.levels} ` : ` depth ${S.depth} `}</Text>
        <Button key="depth-up" plain dimColor label="›" onPress={() => void key($, ']')} />
      </Box>,
      <Input key="find" label="/ " placeholder={S.mode === 'functions' ? 'find a function' : 'find a file'} submitLabel="focus" value="" onSubmit={(q: string) => { find(q); redraw($) }} />,
      <Box key="stage" position="relative" width={cols} height={rows}>
        {picture}
        {d.labels.map((l, i) => (
          <Box key={`l${i}`} position="absolute" top={l.y} left={l.x}>
            <Text color={l.color} bold={l.bold}>{l.text}</Text>
          </Box>
        ))}
        <Box key="hit" position="absolute" top={0} left={0}>
          <Client key="graph" module="./overlay.tsx" props={{ cols, rows } satisfies OverlayProps} />
        </Box>
      </Box>,
      ...lines,
      <Box flexGrow={1} />,
      <Text color={C.muted} wrap="truncate-end">click: focus · again: open folder · drag · wheel zoom · [ ] levels/depth · m mode · u up · g near/all · o unlinked · p pixels/text · esc</Text>,
    )
  })
}
