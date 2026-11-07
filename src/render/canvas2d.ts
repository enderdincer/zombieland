import type { MapDef } from "../../shared/maps"
import type { RenderBackend } from "./backend"
import type { LevelData } from "./level-mesh"
import { LIGHT_FLOATS } from "./lighting"
import type { Mesh } from "./mesh"
import { type FrameInput, SPRITE_FLOATS } from "./renderer"

type Rect = readonly [number, number, number, number]

const FLOOR: Record<string, string> = { carpet: "#232b40", tile: "#2c3342", wood: "#3a2e24", concrete: "#2a2c33", grate: "#24282f" }
/** Rough heights for furniture, for the raised tops. */
const PROP_H: Record<string, number> = { desk: 0.75, table: 0.75, counter: 1, reception: 1.05, chair: 0.5, sofa: 0.7, cabinet: 1.2, bookshelf: 1.8, vending: 1.9, fridge: 1.8, cooler: 1.3, copier: 1.1, printer: 1, plant: 1, crate: 0.8, whiteboard: 1.7, exitdoor: 2.1, lamp: 1.5, boards: 1.6, ladder: 1.8 }
const PROP_COLOR = "#3b4357"

/**
 * The fallback for browsers with no GPU access (Mullvad and Tor by default): the same match drawn flat on a 2D
 * canvas through the game's own camera, so aiming, labels and the HUD all line up. Floors and light pools, furniture
 * and walls as raised boxes, glass, the effect sprites (rings, health arcs, tracers, glows, smoke), and everyone as a
 * disc with a gun line. No meshes, shadows or bloom.
 */
export class Canvas2dRenderer implements RenderBackend {
  readonly kind = "2d"
  width = 0
  height = 0
  drawnChunks = 0
  private map: MapDef | null = null
  private models = 0
  private m = new Float32Array(16)

  constructor(private ctx: CanvasRenderingContext2D) {}

  addModel(_mesh: Mesh): number {
    return this.models++
  }

  setLevel(_level: LevelData, map?: MapDef): void {
    this.map = map ?? null
  }

  resize(w: number, h: number): void {
    this.width = w
    this.height = h
  }

  /** Plan point (x, z) at height y to canvas pixels, through the frame's view-projection; null behind the camera. */
  private p(x: number, y: number, z: number): [number, number] | null {
    const m = this.m
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
    if (cw <= 0.01) return null
    return [((cx / cw + 1) / 2) * this.width, ((1 - cy / cw) / 2) * this.height]
  }

  /** Fills (and optionally strokes) a plan rect at height y. */
  private rect(r: Rect, y: number, fill: string | null, stroke?: string): void {
    const a = this.p(r[0], y, r[1])
    const b = this.p(r[2], y, r[1])
    const c = this.p(r[2], y, r[3])
    const d = this.p(r[0], y, r[3])
    if (!a || !b || !c || !d) return
    const g = this.ctx
    g.beginPath()
    g.moveTo(a[0], a[1])
    g.lineTo(b[0], b[1])
    g.lineTo(c[0], c[1])
    g.lineTo(d[0], d[1])
    g.closePath()
    if (fill) {
      g.fillStyle = fill
      g.fill()
    }
    if (stroke) {
      g.strokeStyle = stroke
      g.stroke()
    }
  }

  /** A box: its south face (toward the camera) and its top. */
  private box(r: Rect, h: number, top: string, side: string, edge?: string): void {
    const g = this.ctx
    const a = this.p(r[0], 0, r[3])
    const b = this.p(r[2], 0, r[3])
    const c = this.p(r[2], h, r[3])
    const d = this.p(r[0], h, r[3])
    if (a && b && c && d) {
      g.beginPath()
      g.moveTo(a[0], a[1])
      g.lineTo(b[0], b[1])
      g.lineTo(c[0], c[1])
      g.lineTo(d[0], d[1])
      g.closePath()
      g.fillStyle = side
      g.fill()
    }
    this.rect(r, h, top, edge)
  }

  private within(r: Rect, v: readonly [number, number, number, number]): boolean {
    return !(r[0] > v[2] + 2 || r[2] < v[0] - 2 || r[1] > v[3] + 2 || r[3] < v[1] - 2)
  }

  /** A circle on the plan at height y, as the projected polygon; `a0..a1` for an arc. */
  private ring(x: number, y: number, z: number, r: number, a0 = 0, a1 = Math.PI * 2): [number, number][] {
    const pts: [number, number][] = []
    const n = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 28))
    for (let i = 0; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n
      const q = this.p(x + Math.cos(t) * r, y, z + Math.sin(t) * r)
      if (q) pts.push(q)
    }
    return pts
  }

  private path(pts: [number, number][], close: boolean): void {
    const g = this.ctx
    g.beginPath()
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
    if (close) g.closePath()
  }

  render(f: FrameInput): void {
    const g = this.ctx
    this.m.set(f.frame.subarray(0, 16))
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = "source-over"
    g.globalAlpha = 1
    g.fillStyle = "#05070d"
    g.fillRect(0, 0, this.width, this.height)
    const map = this.map
    const v = f.view
    if (map) {
      for (const fl of map.floors) if (this.within(fl.rect, v)) this.rect(fl.rect, 0, FLOOR[fl.kind] ?? FLOOR.carpet!)
      for (const t of map.tape) if (this.within(t, v)) this.rect(t, 0.002, "rgba(230,190,60,0.35)")
    }
    // Light pools: each culled light as a soft disc of its colour on the floor.
    g.globalCompositeOperation = "lighter"
    for (let i = 0; i < f.lightCount; i++) {
      const o = i * LIGHT_FLOATS
      const L = f.lights
      const power = L[o + 7]!
      if (power <= 0.01) continue
      const c = this.p(L[o]!, 0, L[o + 2]!)
      const e = this.p(L[o]! + L[o + 3]!, 0, L[o + 2]!)
      if (!c || !e) continue
      const rad = Math.max(4, Math.hypot(e[0] - c[0], e[1] - c[1]))
      const k = Math.min(1, power * 0.45)
      const col = (a: number) => `rgba(${Math.round(L[o + 4]! * 255)},${Math.round(L[o + 5]! * 255)},${Math.round(L[o + 6]! * 255)},${a})`
      const grad = g.createRadialGradient(c[0], c[1], 0, c[0], c[1], rad)
      grad.addColorStop(0, col(0.32 * k))
      grad.addColorStop(0.5, col(0.12 * k))
      grad.addColorStop(1, col(0))
      g.fillStyle = grad
      g.beginPath()
      g.arc(c[0], c[1], rad, 0, Math.PI * 2)
      g.fill()
    }
    g.globalCompositeOperation = "source-over"
    if (map) {
      g.lineWidth = 1
      // Everything is drawn squat (a plan, not a model): full-height boxes would hide the floor at this camera angle.
      for (const pr of map.props) if (this.within(pr.rect, v)) this.box(pr.rect, Math.min(0.45, (PROP_H[pr.kind] ?? 0.8) * 0.4), PROP_COLOR, "#262c3b", "rgba(140,160,210,0.25)")
      for (const r of [...map.windows, ...map.glass]) if (this.within(r, v)) this.rect(r, 0.05, "rgba(90,150,220,0.45)", "rgba(120,190,255,0.6)")
      for (const w of map.walls) if (this.within(w.rect, v)) this.box(w.rect, Math.min(0.7, w.h * 0.3), "#4a5577", "#1b2030", "rgba(120,150,255,0.55)")
    }
    // Bodies on the floor.
    for (const c of f.corpses ?? []) {
      const pts = this.ring(c.x, 0.01, c.y, 0.42)
      this.path(pts, true)
      g.fillStyle = `rgba(${c.color.map((k) => Math.round(Math.min(1, k) * 120)).join(",")},0.55)`
      g.fill()
    }
    this.sprites(f.alphaSprites, f.alphaCount, false)
    // Everyone: a disc in their colour, a darker core, and the gun along the aim.
    for (const a of f.actors ?? []) {
      if (!a.alive) continue
      const col = `rgb(${a.color.map((k) => Math.round(Math.min(1, k) * 255)).join(",")})`
      const r = a.zombie === "boss" ? 0.62 : a.zombie === "brute" ? 0.46 : 0.34
      const body = this.ring(a.x, 0.5, a.y, r)
      this.path(body, true)
      g.fillStyle = a.zombie ? "#1d2a1a" : "#1b2234"
      g.fill()
      g.lineWidth = 2
      g.strokeStyle = col
      g.stroke()
      const head = this.ring(a.x, 0.55, a.y, r * 0.42)
      this.path(head, true)
      g.fillStyle = col
      g.fill()
      const s = this.p(a.x + Math.cos(a.aim) * r * 0.5, 0.55, a.y + Math.sin(a.aim) * r * 0.5)
      const e = this.p(a.x + Math.cos(a.aim) * (r + (a.zombie ? 0.25 : 0.65)), 0.55, a.y + Math.sin(a.aim) * (r + (a.zombie ? 0.25 : 0.65)))
      if (s && e) {
        g.beginPath()
        g.moveTo(s[0], s[1])
        g.lineTo(e[0], e[1])
        g.lineWidth = a.zombie ? 4 : 3
        g.strokeStyle = a.zombie ? col : "#c9cfdb"
        g.stroke()
      }
    }
    this.sprites(f.addSprites, f.addCount, true)
    // The grade: darken and redden when hurt or dead.
    const [, desat, flash] = f.grade
    if (desat > 0) {
      g.globalCompositeOperation = "saturation"
      g.fillStyle = `rgba(128,128,128,${desat})`
      g.fillRect(0, 0, this.width, this.height)
    }
    g.globalCompositeOperation = "source-over"
    if (flash > 0) {
      const grad = g.createRadialGradient(this.width / 2, this.height / 2, Math.min(this.width, this.height) * 0.25, this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.7)
      grad.addColorStop(0, "rgba(140,10,15,0)")
      grad.addColorStop(1, `rgba(140,10,15,${Math.min(0.8, flash)})`)
      g.fillStyle = grad
      g.fillRect(0, 0, this.width, this.height)
    }
  }

  /** The game's sprites: ground rings, arcs, lines, discs and wedges on the plan; glows and puffs as soft dots. */
  private sprites(data: Float32Array, count: number, additive: boolean): void {
    const g = this.ctx
    g.globalCompositeOperation = additive ? "lighter" : "source-over"
    for (let i = 0; i < count; i++) {
      const o = i * SPRITE_FLOATS
      const x = data[o]!
      const y = data[o + 1]!
      const z = data[o + 2]!
      const size = data[o + 3]!
      const a = Math.min(1, data[o + 7]!)
      if (a <= 0.01 || size <= 0) continue
      const kind = Math.round(data[o + 8]!)
      const rot = data[o + 9]!
      const stretch = data[o + 10]!
      const extra = data[o + 11]!
      const c = [data[o + 4]!, data[o + 5]!, data[o + 6]!].map((k) => Math.round(Math.min(1, Math.max(0, k)) ** (1 / 2.2) * 255))
      const rgba = (k: number) => `rgba(${c[0]},${c[1]},${c[2]},${k})`
      // Metres to pixels here, for widths.
      const q0 = this.p(x, y, z)
      const q1 = this.p(x + 1, y, z)
      const px = q0 && q1 ? Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) : 30
      if (kind === 2 || kind === 3 || kind === 5 || kind === 9) {
        // Rings (and the health arc: `extra` either side of rot).
        const w = Math.max(1.5, stretch * size * px)
        const pts = kind === 9 ? this.ring(x, y, z, size * (1 - stretch / 2), rot - extra, rot + extra) : this.ring(x, y, z, size * (1 - stretch / 2))
        this.path(pts, kind !== 9)
        g.lineWidth = w
        g.setLineDash(kind === 5 ? [6, 6] : [])
        g.strokeStyle = rgba(a)
        g.stroke()
        g.setLineDash([])
      } else if (kind === 4) {
        // A line along rot: tracers, throw arcs, hardpoint edges.
        const dx = Math.cos(rot) * size
        const dz = Math.sin(rot) * size
        const s = this.p(x - dx, y, z - dz)
        const e = this.p(x + dx, y, z + dz)
        if (!s || !e) continue
        g.beginPath()
        g.moveTo(s[0], s[1])
        g.lineTo(e[0], e[1])
        g.lineWidth = Math.max(1.5, 2 * stretch * size * px)
        g.strokeStyle = rgba(a)
        g.stroke()
      } else if (kind === 6) {
        this.path(this.ring(x, y, z, size), true)
        g.fillStyle = rgba(a * 0.8)
        g.fill()
      } else if (kind === 8) {
        // The claymore's cone.
        const pts = this.ring(x, y, z, size, rot - extra, rot + extra)
        const ctr = this.p(x, y, z)
        if (!ctr) continue
        this.path([ctr, ...pts], true)
        g.fillStyle = rgba(a * 0.25)
        g.fill()
      } else if (kind === 7) {
        const q = this.p(x, y, z)
        if (!q) continue
        g.fillStyle = rgba(a)
        g.font = "bold 18px monospace"
        g.textAlign = "center"
        g.fillText("!", q[0], q[1])
      } else {
        // Glows, sparks and smoke: a soft dot sized by its projected radius.
        const q = this.p(x, y, z)
        const e = this.p(x + size, y, z)
        if (!q || !e) continue
        const rad = Math.max(1, Math.hypot(e[0] - q[0], e[1] - q[1]))
        const grad = g.createRadialGradient(q[0], q[1], 0, q[0], q[1], rad)
        grad.addColorStop(0, rgba(a))
        grad.addColorStop(1, rgba(0))
        g.fillStyle = grad
        g.beginPath()
        g.arc(q[0], q[1], rad, 0, Math.PI * 2)
        g.fill()
      }
    }
    g.globalCompositeOperation = "source-over"
  }
}
