// Force layout and a braille rasterizer: the Obsidian graph look in a terminal.

export type Pos = Map<string, [number, number]>
export type Seg = { t: string; c?: string; b?: boolean; bg?: string }
export type View = { cx: number; cy: number; z: number }
export type Style = { color: (id: string) => string; edge: string; hot: string; dim: string; label: string }

function seed(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

// Fruchterman–Reingold with a pull to the centre, so loose parts stay close.
// A link pulls less when it touches a hub, so hubs don't swallow their
// neighbours (the same trick as d3-force, which Obsidian's graph uses).
// ponytail: O(n²) per step, fine to ~500 nodes; Barnes–Hut if graphs get bigger.
// `from` keeps nodes where an earlier layout put them, so a view that changes
// (a new focus, a deeper ring) moves calmly instead of jumping.
export function layout(ids: string[], edges: [string, string][], steps = 220, from?: Pos): Pos {
  const n = ids.length
  const at = new Map(ids.map((id, i) => [id, i]))
  const x = ids.map(id => from?.get(id)?.[0] ?? seed(id))
  const y = ids.map(id => from?.get(id)?.[1] ?? seed(id + '~'))
  const links = edges.flatMap(([a, b]) => (at.has(a) && at.has(b) && a !== b ? [[at.get(a)!, at.get(b)!]] : []))
  const deg = new Array(n).fill(0)
  for (const [a, b] of links) { deg[a!]++; deg[b!]++ }
  const k = Math.sqrt(1 / Math.max(1, n))
  const far = (4 * k) ** 2
  let temp = from && ids.some(id => from.has(id)) ? 0.04 : 0.1
  for (let s = 0; s < steps; s++) {
    const dx = new Array(n).fill(0)
    const dy = new Array(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ux = x[i]! - x[j]!
        const uy = y[i]! - y[j]!
        const d2 = Math.max(1e-6, ux * ux + uy * uy)
        if (d2 > far) continue // repel only nearby nodes, so loose parts aren't pushed out
        const f = (k * k) / d2
        dx[i] += ux * f; dy[i] += uy * f
        dx[j] -= ux * f; dy[j] -= uy * f
      }
      dx[i] += (0.5 - x[i]!) * 0.15 * k
      dy[i] += (0.5 - y[i]!) * 0.15 * k
    }
    for (const [a, b] of links) {
      const ux = x[a!]! - x[b!]!
      const uy = y[a!]! - y[b!]!
      const d = Math.sqrt(ux * ux + uy * uy) || 1e-3
      const f = d / k / Math.sqrt(Math.min(deg[a!], deg[b!]))
      dx[a!] -= ux * f; dy[a!] -= uy * f
      dx[b!] += ux * f; dy[b!] += uy * f
    }
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1
      const step = Math.min(d, temp)
      x[i] = x[i]! + (dx[i] / d) * step
      y[i] = y[i]! + (dy[i] / d) * step
    }
    temp *= 0.985
  }
  // Fit the middle 90% into 0.05..0.95, same scale on both axes; stragglers
  // (small loose components) sit on the rim instead of shrinking everything.
  const q = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor(p * (v.length - 1))]!
  const [x0, x1, y0, y1] = n > 20 ? [q(x, 0.05), q(x, 0.95), q(y, 0.05), q(y, 0.95)] : [Math.min(...x), Math.max(...x), Math.min(...y), Math.max(...y)]
  const span = Math.max(x1 - x0, y1 - y0, 1e-6)
  const fit = (v: number, v0: number, v1: number) => Math.max(0.01, Math.min(0.99, 0.05 + (0.9 * (v - v0 + (span - (v1 - v0)) / 2)) / span))
  return new Map(ids.map((id, i) => [id, [fit(x[i]!, x0, x1), fit(y[i]!, y0, y1)]]))
}

const BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]

type Draw = { pos: Pos; edges: [string, string][]; focus: string; near: Set<string>; labels: string[]; names: Map<string, string>; big: Set<string> }

// Draws the graph into `cols`×`rows` cells. Returns the rows as colour runs and
// where each node landed, for clicks.
export function raster(d: Draw, cols: number, rows: number, view: View, s: Style) {
  const W = cols * 2
  const H = rows * 4
  const scale = Math.min(W, H) // a cell is ~1:2, so its 2×4 braille dots are square
  const proj = ([px, py]: [number, number]): [number, number] => [
    Math.round(((px - view.cx) * view.z) * scale + W / 2),
    Math.round(((py - view.cy) * view.z) * scale + H / 2),
  ]
  const mask = new Uint8Array(cols * rows)
  const hot = new Uint8Array(cols * rows)
  const dot = (X: number, Y: number, isHot: boolean) => {
    if (X < 0 || Y < 0 || X >= W || Y >= H) return
    const c = (Y >> 2) * cols + (X >> 1)
    mask[c]! |= BITS[Y & 3]![X & 1]!
    if (isHot) hot[c] = 1
  }
  for (const [a, b] of d.edges) {
    const pa = d.pos.get(a)
    const pb = d.pos.get(b)
    if (!pa || !pb) continue
    let [x0, y0] = proj(pa)
    const [x1, y1] = proj(pb)
    const isHot = Boolean(d.focus) && (a === d.focus || b === d.focus)
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (let guard = 0; guard < 4 * (W + H); guard++) {
      dot(x0, y0, isHot)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  const cells: { t: string; c?: string; b?: boolean }[] = Array.from({ length: cols * rows }, (_, i) =>
    mask[i] ? { t: String.fromCharCode(0x2800 + mask[i]!), c: hot[i] ? s.hot : s.edge } : { t: ' ' })
  const taken = new Uint8Array(cols * rows)
  const hits: { id: string; x: number; y: number }[] = []
  for (const [id, p] of d.pos) {
    const [X, Y] = proj(p)
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue
    const cx = X >> 1, cy = Y >> 2, c = cy * cols + cx
    const isFocus = id === d.focus
    const faded = Boolean(d.focus) && !d.near.has(id)
    cells[c] = { t: isFocus || d.big.has(id) ? '●' : '•', c: faded ? s.dim : s.color(id), b: isFocus }
    taken[c] = 1
    hits.push({ id, x: cx, y: cy })
  }
  // Labels: to the right of the node, else to the left; skipped if they'd overlap.
  for (const id of d.labels) {
    const hit = hits.find(h => h.id === id)
    if (!hit) continue
    const text = d.names.get(id) ?? id
    const fits = (from: number) => from >= 0 && from + text.length <= cols && [...text].every((_, i) => !taken[hit.y * cols + from + i])
    const from = fits(hit.x + 2) ? hit.x + 2 : fits(hit.x - 1 - text.length) ? hit.x - 1 - text.length : -1
    if (from < 0) continue
    ;[...text].forEach((ch, i) => {
      const c = hit.y * cols + from + i
      cells[c] = { t: ch, c: id === d.focus ? s.hot : s.label, b: id === d.focus }
      taken[c] = 1
    })
  }
  const out: Seg[][] = []
  for (let r = 0; r < rows; r++) {
    const line: Seg[] = []
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c]!
      const last = line[line.length - 1]
      if (last && last.c === cell.c && last.b === cell.b) last.t += cell.t
      else line.push({ t: cell.t, c: cell.c, b: cell.b })
    }
    out.push(line.map(seg => Object.fromEntries(Object.entries(seg).filter(([, v]) => v !== undefined)) as Seg))
  }
  return { rows: out, hits }
}

// The node under a click, if one is within a couple of cells.
export function nearest(hits: { id: string; x: number; y: number }[], x: number, y: number): string {
  let best = ''
  let bestD = 6
  for (const h of hits) {
    const d = Math.abs(h.x - x) + 2 * Math.abs(h.y - y)
    if (d < bestD) { best = h.id; bestD = d }
  }
  return best
}
