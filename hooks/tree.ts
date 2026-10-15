// The Files tab: every tracked file in its folders, with link counts per code file.
import type { Seg } from './layout'

export type TreeState = { expanded: Set<string>; cursor: string; top: number; focus: string; touched: Set<string> }
export type Row = { id: string; dir: boolean }

const clean = (segs: Seg[]) => segs.filter(s => s.t).map(s => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Seg)

// Moves `st.cursor` and `st.top` so the cursor stays on screen.
export function treeRows(files: string[], edges: [string, string][], st: TreeState, color: (group: string) => string, C: Record<string, string>, cols: number, rows: number) {
  const ins = new Map<string, number>()
  const outs = new Map<string, number>()
  for (const [a, b] of edges) { outs.set(a, (outs.get(a) ?? 0) + 1); ins.set(b, (ins.get(b) ?? 0) + 1) }
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
      if (isDir(id) && st.expanded.has(id)) walk(id, depth + 1)
    }
  }
  walk('', 0)
  if (!st.cursor || !list.some(r => r.id === st.cursor)) st.cursor = list[0]?.id ?? ''
  const at = list.findIndex(r => r.id === st.cursor)
  if (at < st.top) st.top = at
  if (at >= st.top + rows) st.top = at - rows + 1
  st.top = Math.max(0, Math.min(st.top, Math.max(0, list.length - rows)))
  const drawn = list.slice(st.top, st.top + rows).map(({ id, depth }) => {
    const dir = isDir(id)
    const name = id.split('/').pop()!
    const bg = id === st.cursor ? C.sel : undefined
    const counts = dir ? '' : `${ins.get(id) ? ` ←${ins.get(id)}` : ''}${outs.get(id) ? ` →${outs.get(id)}` : ''}`
    const left = `${'  '.repeat(depth)}${dir ? (st.expanded.has(id) ? '▾ ' : '▸ ') : '  '}`
    const room = Math.max(4, cols - left.length - counts.length - 2)
    const shown = name.length > room ? name.slice(0, room - 1) + '…' : name
    const dot = dir ? '■ ' : '• '
    const tint = st.touched.has(id) ? C.touched : color(id.includes('/') ? id.split('/')[0]! : '.')
    const pad = ' '.repeat(Math.max(0, cols - left.length - dot.length - shown.length - counts.length))
    return clean([
      { t: left, c: C.muted, bg },
      { t: dot, c: tint, bg },
      { t: shown, c: id === st.focus ? C.hot : C.fg, b: id === st.focus, bg },
      { t: pad, bg },
      { t: counts, c: C.muted, bg },
    ])
  })
  return { rows: drawn, list: list.map(r => ({ id: r.id, dir: isDir(r.id) })) }
}
