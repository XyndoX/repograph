// What the Graph tab shows: the nodes and links for a mode, a folder scope, and
// a focus with its neighbourhood up to a depth. Pure, so it's easy to test.
import type { Graph } from './scan'

export type Mode = 'folders' | 'files' | 'functions'
export type VNode = { id: string; label: string; group: string; kind: 'file' | 'fn' | 'folder' | 'outside'; file: string }
export type VEdge = { a: string; b: string; w: number }
export type ViewInput = { mode: Mode; scope: string; focus: string; depth: number; local: boolean; orphans: boolean; cap: number }

const inside = (scope: string, f: string) => !scope || f.startsWith(scope + '/')
const top = (f: string) => (f.includes('/') ? f.split('/')[0]! : '.')

// Where a path outside the scope is drawn: the folder where it leaves the scope's
// path, so a sibling folder is one node and a far one is its top-level folder.
export function bucket(scope: string, f: string): string {
  const s = scope ? scope.split('/') : []
  const p = f.split('/')
  let i = 0
  while (i < s.length && p[i] === s[i]) i++
  return p.slice(0, i + 1).join('/')
}

// Inside the scope, folders mode draws each child folder of the scope as one node.
function child(scope: string, f: string): { id: string; folder: boolean } {
  const rel = scope ? f.slice(scope.length + 1) : f
  const cut = rel.indexOf('/')
  return cut < 0 ? { id: f, folder: false } : { id: (scope ? scope + '/' : '') + rel.slice(0, cut), folder: true }
}

export function view(g: Graph, v: ViewInput) {
  const base = v.mode === 'functions' ? g.fns : g.files
  const baseEdges = v.mode === 'functions' ? g.fnEdges : g.fileEdges
  const byId = new Map(base.map(n => [n.id, n]))
  const fileOf = new Map(base.map(n => [n.id, n.file]))
  const nodes = new Map<string, VNode>()
  const keyOf = (id: string): string => {
    const file = fileOf.get(id)!
    if (!inside(v.scope, file)) {
      const b = bucket(v.scope, file)
      const key = `out:${b}`
      if (!nodes.has(key)) nodes.set(key, { id: key, label: b === file ? b : `${b}/`, group: top(file), kind: 'outside', file: b })
      return key
    }
    if (v.mode === 'folders') {
      const c = child(v.scope, file)
      if (!nodes.has(c.id)) nodes.set(c.id, { id: c.id, label: c.id.split('/').pop()! + (c.folder ? '/' : ''), group: top(file), kind: c.folder ? 'folder' : 'file', file: c.id })
      return c.id
    }
    const n = byId.get(id)!
    if (!nodes.has(id)) nodes.set(id, { id, label: n.label, group: n.group, kind: v.mode === 'functions' ? 'fn' : 'file', file })
    return id
  }
  for (const n of base) if (inside(v.scope, n.file)) keyOf(n.id)
  const weights = new Map<string, number>()
  for (const [a0, b0] of baseEdges) {
    const fa = fileOf.get(a0), fb = fileOf.get(b0)
    if (!fa || !fb || (!inside(v.scope, fa) && !inside(v.scope, fb))) continue
    const a = keyOf(a0), b = keyOf(b0)
    if (a !== b) weights.set(`${a}\0${b}`, (weights.get(`${a}\0${b}`) ?? 0) + 1)
  }
  const edges: VEdge[] = [...weights].map(([k, w]) => { const [a, b] = k.split('\0') as [string, string]; return { a, b, w } })

  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => adj.set(a, (adj.get(a) ?? new Set()).add(b))
  for (const e of edges) { link(e.a, e.b); link(e.b, e.a) }
  const deg = (id: string) => adj.get(id)?.size ?? 0

  // A focus can be a node, or a file whose functions stand in for it.
  const seeds = !v.focus ? [] : nodes.has(v.focus) ? [v.focus] : [...nodes.values()].filter(n => n.file === v.focus).map(n => n.id)
  const dist = new Map(seeds.map(s => [s, 0]))
  let ring = seeds
  for (let d = 1; d <= v.depth; d++) {
    ring = ring.flatMap(id => [...(adj.get(id) ?? [])]).filter(id => !dist.has(id))
    for (const id of ring) dist.set(id, d)
  }

  let ids = [...nodes.keys()]
  let hidden = 0
  if (v.local && seeds.length) ids = ids.filter(id => dist.has(id))
  else {
    const before = ids.length
    ids = ids.filter(id => v.orphans || deg(id) > 0 || dist.has(id))
    hidden = before - ids.length
    if (ids.length > v.cap) {
      const keep = new Set([...ids].sort((a, b) => deg(b) - deg(a)).slice(0, v.cap))
      for (const id of dist.keys()) keep.add(id)
      ids = ids.filter(id => keep.has(id))
    }
  }
  const shown = new Set(ids)
  const seedSet = new Set(seeds)
  const out = new Set(edges.filter(e => seedSet.has(e.a) && !seedSet.has(e.b)).map(e => e.b))
  const inn = new Set(edges.filter(e => seedSet.has(e.b) && !seedSet.has(e.a)).map(e => e.a))
  return {
    nodes: ids.map(id => nodes.get(id)!),
    edges: edges.filter(e => shown.has(e.a) && shown.has(e.b)),
    total: nodes.size,
    hidden,
    seeds,
    dist,
    deg,
    out,
    inn,
  }
}
