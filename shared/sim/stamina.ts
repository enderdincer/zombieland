/**
 * Sprint stamina, shared by the server and client prediction so both agree on when you can run. A full bar lasts
 * `drain` seconds of sprinting. Stop and it refills over `refill` seconds after a `calm` pause. Run it dry and you're
 * winded: no sprinting for `rest` seconds and no refill, then it refills but you can't sprint again until it's back
 * to `recover`.
 */
export const STAMINA = { drain: 4.5, refill: 3, calm: 0.6, rest: 1.5, recover: 0.35 }

export type Stamina = {
  /** 0..1. */
  left: number
  /** Seconds until the bar starts refilling. */
  calm: number
  /** Seconds of the cool-off after running dry. */
  rest: number
  /** Ran dry and not yet back to `recover`. */
  winded: boolean
}

export const freshStamina = (): Stamina => ({ left: 1, calm: 0, rest: 0, winded: false })

/** One tick: whether a sprint you want (`wants`) actually happens, draining or refilling the bar. */
export function stepStamina(s: Stamina, wants: boolean, dt: number): boolean {
  if (s.rest > 0) s.rest = Math.max(0, s.rest - dt)
  const can = wants && !s.winded && s.left > 0
  if (can) {
    s.left = Math.max(0, s.left - dt / STAMINA.drain)
    s.calm = STAMINA.calm
    if (s.left === 0) {
      s.winded = true
      s.rest = STAMINA.rest
    }
    return true
  }
  if (s.rest > 0) return false
  if (s.calm > 0) s.calm = Math.max(0, s.calm - dt)
  else s.left = Math.min(1, s.left + dt / STAMINA.refill)
  if (s.winded && s.left >= STAMINA.recover) s.winded = false
  return false
}
