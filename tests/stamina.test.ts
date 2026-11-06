import { describe, expect, test } from "bun:test"
import { DT, SPEED, SPRINT_SPEED } from "../shared/config"
import { STAMINA, freshStamina, stepStamina } from "../shared/sim/stamina"
import { place, run, world } from "./helpers"

const ticks = (s: number) => Math.round(s / DT)

describe("stamina", () => {
  test("a full bar lasts the drain time, then you're winded through the rest", () => {
    const s = freshStamina()
    let ran = 0
    for (let i = 0; i < ticks(STAMINA.drain + 1); i++) if (stepStamina(s, true, DT)) ran++
    expect(ran * DT).toBeCloseTo(STAMINA.drain, 1)
    expect(s.winded).toBe(true)
    // Still winded right after the cool-off, even holding sprint.
    for (let i = 0; i < ticks(STAMINA.rest); i++) expect(stepStamina(s, true, DT)).toBe(false)
  })

  test("it refills after a pause, and a winded runner waits until it's back to recover", () => {
    const s = { left: 0, calm: 0, rest: STAMINA.rest, winded: true }
    for (let i = 0; i < ticks(STAMINA.rest); i++) stepStamina(s, false, DT)
    expect(s.left).toBeLessThan(0.02)
    for (let i = 0; i < ticks(STAMINA.recover * STAMINA.refill * 0.8); i++) stepStamina(s, false, DT)
    expect(stepStamina({ ...s }, true, DT)).toBe(false)
    for (let i = 0; i < ticks(STAMINA.refill); i++) stepStamina(s, false, DT)
    expect(s.left).toBe(1)
    expect(s.winded).toBe(false)
    expect(stepStamina(s, true, DT)).toBe(true)
  })

  test("the server slows you to a walk once you run dry", () => {
    const w = world(["a"])
    const a = place(w, "a", 3, 10)
    run(w, 1, () => ({ mx: 1, sprint: true }))
    expect(Math.hypot(a.vx, a.vy)).toBeCloseTo(SPRINT_SPEED, 0)
    place(w, "a", 3, 10)
    a.stamina.left = 0.01
    run(w, 1, () => ({ mx: 1, sprint: true }))
    expect(a.stamina.winded).toBe(true)
    expect(Math.hypot(a.vx, a.vy)).toBeCloseTo(SPEED, 0)
  })
})
