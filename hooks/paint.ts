// Paints the graph into RGBA pixels for an `Image` (kitty graphics: Ghostty, cmux,
// kitty). Transparent background, so the terminal's own theme shows through.

export type RGB = [number, number, number]
export type Line = { x0: number; y0: number; x1: number; y1: number; c: RGB; a: number; w: number }
export type Dot = { x: number; y: number; r: number; c: RGB; a: number; ring?: boolean; halo?: boolean }

export function hex(h: string): RGB {
  const v = parseInt(h.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

export class Canvas {
  W: number
  H: number
  px: Uint8ClampedArray
  constructor(W: number, H: number) {
    this.W = W
    this.H = H
    this.px = new Uint8ClampedArray(W * H * 4)
  }

  // "Over" compositing on straight alpha.
  blend(x: number, y: number, c: RGB, a: number) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.W || y >= this.H) return
    const i = (y * this.W + x) * 4
    const da = this.px[i + 3]! / 255
    const oa = a + da * (1 - a)
    for (let k = 0; k < 3; k++) this.px[i + k] = (c[k]! * a + this.px[i + k]! * da * (1 - a)) / oa
    this.px[i + 3] = oa * 255
  }

  // A line `w` pixels wide with soft edges. It walks the longer axis and covers a
  // short run across it, so each pixel is touched once and long lines stay cheap.
  line(l: Line) {
    const steep = Math.abs(l.y1 - l.y0) > Math.abs(l.x1 - l.x0)
    // Work as if the line were flat: swap x and y for a steep one.
    let [a0, b0, a1, b1] = steep ? [l.y0, l.x0, l.y1, l.x1] : [l.x0, l.y0, l.x1, l.y1]
    if (a0 > a1) [a0, b0, a1, b1] = [a1, b1, a0, b0]
    const slope = a1 - a0 < 1e-6 ? 0 : (b1 - b0) / (a1 - a0)
    const cos = 1 / Math.sqrt(1 + slope * slope)
    const half = l.w / 2
    const lim = (steep ? this.H : this.W) - 1
    for (let a = Math.max(0, Math.floor(a0)); a <= Math.min(lim, Math.ceil(a1)); a++) {
      const end = Math.min(1, Math.max(0, Math.min(a + 1 - a0, a1 - a + 0.5))) // soft caps
      const bc = b0 + (Math.max(a0, Math.min(a1, a + 0.5)) - a0) * slope
      for (let b = Math.floor(bc - half - 1); b <= Math.ceil(bc + half + 1); b++) {
        const d = Math.abs(b + 0.5 - bc) * cos
        const cover = Math.max(0, Math.min(1, half + 0.5 - d)) * end
        if (cover > 0) steep ? this.blend(b, a, l.c, cover * l.a) : this.blend(a, b, l.c, cover * l.a)
      }
    }
  }

  dot(d: Dot) {
    const R = d.r + (d.halo ? d.r * 1.2 : 0) + 1
    for (let y = Math.floor(d.y - R); y <= Math.ceil(d.y + R); y++) {
      for (let x = Math.floor(d.x - R); x <= Math.ceil(d.x + R); x++) {
        const dist = Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y)
        if (d.halo) this.blend(x, y, d.c, Math.max(0, Math.min(1, d.r * 2.2 - dist)) * 0.18 * d.a)
        const cover = d.ring
          ? Math.max(0, Math.min(1, 1.6 - Math.abs(dist - d.r)))
          : Math.max(0, Math.min(1, d.r + 0.5 - dist))
        this.blend(x, y, d.c, cover * d.a)
      }
    }
  }

  base64(): string {
    return (new Uint8Array(this.px.buffer) as Uint8Array & { toBase64(): string }).toBase64()
  }
}

// Pixels per cell for a box of `cols`×`rows` cells under the inline image limit
// (2 MiB of RGBA); a cell is about twice as tall as wide.
export function cellSize(cols: number, rows: number, budget = 2 * 1024 * 1024 / 4) {
  const cw = Math.max(3, Math.min(16, Math.floor(Math.sqrt(budget / (cols * rows * 2)))))
  return { cw, ch: cw * 2 }
}
