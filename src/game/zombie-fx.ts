import type { Snapshot } from "../../shared/sim/view"

type Sprite = (add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot?: number, stretch?: number, extra?: number) => void

/**
 * Hold the line: the zone is a ring going from cyan to red as its integrity drains, with an arc showing how much is
 * left, pulsing while the dead are inside.
 */
export function zombieSprites(s: Snapshot, t: number, sprite: Sprite): void {
  const z = s.mode.zombies?.zone
  if (!z) return
  const k = Math.max(0, Math.min(1, z.integrity))
  const c = [0.08 + 0.92 * (1 - k), 0.72 * k + 0.15 * (1 - k), 1.0 * k + 0.1 * (1 - k)]
  const pulse = z.breached ? 0.55 + 0.45 * Math.sin(t * 12) : 1
  sprite(true, z.x, 0.035, z.y, z.r, c[0]! * 1.5, c[1]! * 1.5, c[2]! * 1.5, 0.95 * pulse, 2, 0, 0.03)
  sprite(true, z.x, 0.03, z.y, z.r - 0.3, c[0]!, c[1]!, c[2]!, 0.4, 5, t * 0.35, 0.02)
  sprite(false, z.x, 0.012, z.y, z.r, c[0]! * 0.25, c[1]! * 0.25, c[2]! * 0.25, 0.3, 6)
  if (k > 0) sprite(true, z.x, 0.04, z.y, z.r * 0.85, c[0]!, c[1]!, c[2]!, 0.45, 8, -Math.PI / 2, 1, Math.max(0.02, k * Math.PI))
  // A beacon in the middle, so you can find it across the floor.
  sprite(true, z.x, 0.6 + Math.sin(t * 2) * 0.08, z.y, 0.35, c[0]! * 2, c[1]! * 2, c[2]! * 2, 0.9 * pulse, 0)
}
