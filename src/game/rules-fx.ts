import { at } from "./rig"
import type { Avatar } from "./anim"
import type { RosterRow, Snapshot } from "../../shared/sim/view"

type Rgb = [number, number, number]
/** Infected: survivors in orange, the infected a sickly green. */
export const INF_COLORS: [Rgb, Rgb] = [
  [1.0, 0.38, 0.08],
  [0.35, 1.0, 0.12],
]

/** Zombies by kind: a sickly green walker, a yellower runner, a blood-dark brute. */
export const ZOMBIE_COLORS: Record<string, Rgb> = {
  walker: [0.35, 1.0, 0.12],
  runner: [0.85, 1.0, 0.1],
  brute: [0.9, 0.12, 0.08],
}

/** A zombie's kind, from the snapshot, or "" for anyone else. */
export const zombieOf = (s: Snapshot | null, id: string): string => s?.players.find((p) => p.id === id)?.z ?? ""

/** Whether someone is infected right now, or one of the dead. */
export const infected = (s: Snapshot | null, roster: RosterRow[], id: string): boolean => (s?.mode.id === "inf" && roster.find((r) => r.id === id)?.team === 1) || !!zombieOf(s, id)

type Sprite = (add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number) => void

/** Two glowing eyes on the visor (or in a zombie's sockets, in its colour), flickering a little. */
export function eyes(a: Avatar, t: number, sprite: Sprite, color?: Rgb): void {
  const h = a.body?.head
  if (!h) return
  const k = 0.85 + 0.15 * Math.sin(t * 9 + a.seed)
  const [fwd, up, gap] = a.zombie ? (a.zombie === "brute" ? [0.12, 0.18, 0.05] : [0.105, 0.155, 0.043]) : [0.17, 0.165, 0.05]
  const c = color ? [color[0] * 3, color[1] * 3, color[2] * 3] : [1.6, 3, 0.3]
  for (const side of [-1, 1]) {
    const p = at(h, fwd, up, side * gap)
    sprite(true, p[0], p[1], p[2], 0.045, c[0]! * k, c[1]! * k, c[2]! * k, 1, 0)
  }
}
