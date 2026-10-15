// Draws the Graph tab: the layout, the picture (or braille text as a fallback),
// where the labels go, and which node a click lands on.
import type { Graph } from './scan'
import { layout, raster, type Pos, type Seg } from './layout'
import { Canvas, cellSize, hex, type RGB } from './paint'
import { view, type ViewInput, type VNode } from './view'

export const PALETTE = ['#a882ff', '#53dfdd', '#e5c07b', '#98c379', '#e06c75', '#61afef', '#d19a66', '#c678dd', '#56b6c2', '#ff79c6']
export const OUT = '#a882ff' // what the focus imports or calls
export const IN = '#53dfdd' // what uses or calls the focus
const MUTED = '#8a8a99'

export type Cam = { cx: number; cy: number; z: number }
export type Label = { x: number; y: number; text: string; color: string; bold: boolean }
export type Drawn = {
  v: ReturnType<typeof view>
  image?: { rgba: string; width: number; height: number }
  text?: Seg[][]
  labels: Label[]
  hit: (x: number, y: number) => string // cell coordinates, fractions allowed
  centre: (id: string) => [number, number] | undefined
}

let cache = { key: '', pos: new Map() as Pos }
let picture = { key: '', rgba: '' }

export function draw(g: Graph, vi: ViewInput, cam: Cam, cols: number, rows: number, pixels: boolean, hover: string, touched: Set<string>): Drawn {
  const v = view(g, vi)
  const ids = v.nodes.map(n => n.id)
  const key = `${vi.mode}|${vi.scope}|${vi.local ? vi.focus : ''}|${vi.depth}|${ids.length}|${v.edges.length}|${ids.slice(0, 50).join(',')}`
  if (cache.key !== key) cache = { key, pos: layout(ids, v.edges.map(e => [e.a, e.b]), 220, cache.pos) }
  const pos = cache.pos
  const groups = [...new Set(g.files.map(n => n.group))].sort()
  const colorOf = (n: VNode) => (touched.has(n.file) ? '#f5a623' : n.kind === 'outside' ? MUTED : PALETTE[Math.max(0, groups.indexOf(n.group)) % PALETTE.length]!)
  const focused = v.seeds.length > 0
  const seeds = new Set(v.seeds)

  const { cw, ch } = pixels ? cellSize(cols, rows) : { cw: 2, ch: 4 }
  const W = cols * cw
  const H = rows * ch
  const S = Math.min(W, H) * (pixels ? 0.92 : 1) // the braille fallback projects as raster() does
  const proj = (id: string): [number, number] | undefined => {
    const p = pos.get(id)
    return p && [(p[0] - cam.cx) * cam.z * S + W / 2, (p[1] - cam.cy) * cam.z * S + H / 2]
  }
  const maxDeg = Math.max(1, ...ids.map(v.deg))
  const radius = (n: VNode) => (cw / 6) * (2.2 + 5 * Math.sqrt(v.deg(n.id) / maxDeg)) * (seeds.has(n.id) ? 1.4 : 1)

  // Labels: the focus and its ring nearest first, then the hubs; never overlapping.
  const taken = new Set<string>()
  const labels: Label[] = []
  const ranked = [...v.nodes].sort((a, b) =>
    Number(b.id === hover) - Number(a.id === hover) ||
    (v.dist.get(a.id) ?? 99) - (v.dist.get(b.id) ?? 99) ||
    v.deg(b.id) - v.deg(a.id))
  const budget = focused ? 30 : 14
  for (const n of ranked) {
    if (labels.length >= budget && n.id !== hover) break
    if (focused && !v.dist.has(n.id) && n.id !== hover) continue
    const p = proj(n.id)
    if (!p) continue
    const cx = Math.floor(p[0] / cw)
    const cy = Math.floor(p[1] / ch)
    const text = n.label
    for (const from of [cx + 2, cx - 1 - text.length]) {
      if (cy < 0 || cy >= rows || from < 0 || from + text.length > cols) continue
      const cells = [...Array(text.length).keys()].map(i => `${from + i},${cy}`)
      if (cells.some(c => taken.has(c))) continue
      for (const c of cells) taken.add(c)
      const color = seeds.has(n.id) ? '#ffffff' : v.out.has(n.id) ? OUT : v.inn.has(n.id) ? IN : n.id === hover ? '#ffffff' : n.kind === 'outside' ? MUTED : '#c8c8d0'
      labels.push({ x: from, y: cy, text, color, bold: seeds.has(n.id) || n.id === hover })
      break
    }
  }

  const hit = (x: number, y: number) => {
    let best = ''
    let bestD = Infinity
    for (const n of v.nodes) {
      const p = proj(n.id)
      if (!p) continue
      const d = Math.hypot(p[0] - x * cw, p[1] - y * ch)
      if (d < bestD && d < Math.max(radius(n) + cw, cw * 2.5)) { best = n.id; bestD = d }
    }
    return best
  }
  const centre = (id: string) => pos.get(id)

  if (!pixels) {
    const out = raster(
      { pos, edges: v.edges.map(e => [e.a, e.b]), focus: v.seeds[0] ?? '', near: new Set(v.dist.keys()), labels: [], names: new Map(), big: new Set() },
      cols, rows, cam,
      { color: id => colorOf(v.nodes.find(n => n.id === id)!), edge: '#4a4a52', hot: OUT, dim: '#3a3a3a', label: '#dadada' },
    )
    return { v, text: out.rows, labels, hit, centre }
  }

  const pkey = `${key}|${cam.cx.toFixed(4)},${cam.cy.toFixed(4)},${cam.z.toFixed(3)}|${W}x${H}|${vi.focus}|${[...touched].join(',')}`
  if (picture.key !== pkey) {
    const c = new Canvas(W, H)
    const lw = Math.max(1, cw / 6)
    const edgeStyle = (a: string, b: string): [RGB, number, number] => {
      if (!focused) return [hex(MUTED), 0.28, lw]
      if (seeds.has(a)) return [hex(OUT), 0.95, lw * 1.8]
      if (seeds.has(b)) return [hex(IN), 0.95, lw * 1.8]
      if (v.dist.has(a) && v.dist.has(b)) return [hex(MUTED), 0.35, lw]
      return [hex(MUTED), 0.07, lw]
    }
    // Faint links first, the focus's links on top.
    const order = [...v.edges].sort((e, f) => Number(seeds.has(e.a) || seeds.has(e.b)) - Number(seeds.has(f.a) || seeds.has(f.b)))
    for (const e of order) {
      const pa = proj(e.a), pb = proj(e.b)
      if (!pa || !pb) continue
      const [col, a, w] = edgeStyle(e.a, e.b)
      c.line({ x0: pa[0], y0: pa[1], x1: pb[0], y1: pb[1], c: col, a, w: w * (1 + Math.log2(e.w) * 0.5) })
    }
    for (const n of v.nodes) {
      const p = proj(n.id)
      if (!p || p[0] < -20 || p[1] < -20 || p[0] > W + 20 || p[1] > H + 20) continue
      const d = v.dist.get(n.id)
      const a = !focused ? 1 : d === undefined ? 0.18 : d <= 1 ? 1 : 0.7
      c.dot({ x: p[0], y: p[1], r: radius(n), c: hex(colorOf(n)), a, ring: n.kind === 'outside' || n.kind === 'folder', halo: seeds.has(n.id) })
    }
    picture = { key: pkey, rgba: c.base64() }
  }
  return { v, image: { rgba: picture.rgba, width: W, height: H }, labels, hit, centre }
}
