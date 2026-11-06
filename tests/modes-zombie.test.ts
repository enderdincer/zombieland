import { describe, expect, test } from "bun:test"
import { DT } from "../shared/config"
import type { ModeId } from "../shared/sim/modes"
import { HOLD, type HoldTheLine, ZOMBIE, ZOMBIES, type ZombieMode, waveOf } from "../shared/sim/modes-zombie"
import { Rng } from "../shared/rng"
import { buildSnapshot, rosterOf } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import { place, run, testMap } from "./helpers"

function zWorld(mode: ModeId, names: string[] = ["a"]): World {
  const w = new World(11, testMap(), mode)
  for (const n of names) w.addHuman(n, n)
  w.step()
  w.takeEvents()
  return w
}

const zombies = (w: World) => [...w.players.values()].filter((p) => p.npc)
const mode = (w: World) => w.mode as ZombieMode

describe("zombie waves", () => {
  test("waves grow, and runners and brutes join later", () => {
    const t = { waves: 10, rest: 12, hp: 0.1, speed: 0.02, runners: 3, brutes: 5 }
    const w1 = waveOf(1, 1, t, new Rng(1))
    const w6 = waveOf(6, 1, t, new Rng(1))
    expect(w1.every((k) => k === "walker")).toBe(true)
    expect(w6.length).toBeGreaterThan(w1.length)
    expect(w6).toContain("runner")
    expect(w6).toContain("brute")
    expect(waveOf(3, 4, t, new Rng(1)).length).toBeGreaterThan(waveOf(3, 1, t, new Rng(1)).length)
  })

  test("the first wave spawns after the break, away from the survivors, and they come for you", () => {
    const w = zWorld("zsv")
    const a = w.players.get("a")!
    expect(a.team).toBe(0)
    run(w, ZOMBIE.first - 1)
    expect(zombies(w).length).toBe(0)
    run(w, 1.5)
    expect(w.takeEvents().some((e) => e.k === "wave" && e.what === "start" && e.n === 1)).toBe(true)
    const z = zombies(w).filter((p) => p.alive)
    expect(z.length).toBeGreaterThan(0)
    for (const q of z) {
      expect(q.team).toBe(1)
      expect(Math.hypot(q.x - a.x, q.y - a.y)).toBeGreaterThan(ZOMBIE.spawnMin - 1)
    }
    const d0 = Math.hypot(z[0]!.x - a.x, z[0]!.y - a.y)
    run(w, 2)
    expect(Math.hypot(z[0]!.x - a.x, z[0]!.y - a.y)).toBeLessThan(d0)
  })

  test("zombies stay off the roster but are in the snapshot with their kind", () => {
    const w = zWorld("zsv")
    run(w, ZOMBIE.first + 1)
    expect(rosterOf(w).map((r) => r.id)).toEqual(["a"])
    const snap = buildSnapshot(w, "a")
    expect(snap.players.some((p) => p.z === "walker")).toBe(true)
    expect(snap.mode.zombies).toMatchObject({ wave: 1, waves: 10, state: "wave" })
  })

  test("a swipe hurts instead of killing, and killing one scores", () => {
    const w = zWorld("zsv")
    run(w, ZOMBIE.first + 0.5)
    const a = place(w, "a", 20, 10)
    const z = zombies(w).find((p) => p.alive)!
    place(w, z.id, 21, 10)
    run(w, 1.2)
    expect(a.alive).toBe(true)
    expect(a.health).toBeLessThanOrEqual(100 - ZOMBIES.walker.damage)
    w.damage(z, 1000, a, "rifle", a.x, a.y)
    expect(a.stats.score).toBe(ZOMBIES.walker.score)
    expect(a.kills).toBe(1)
  })

  test("clearing a wave gets the fallen up; everyone down loses", () => {
    const w = zWorld("zsv", ["a", "b"])
    run(w, ZOMBIE.first + 0.5)
    const a = w.players.get("a")!
    const b = w.players.get("b")!
    w.damage(b, 1000, zombies(w)[0]!, "melee", b.x, b.y)
    expect(b.alive).toBe(false)
    run(w, 1)
    expect(b.alive).toBe(false)
    // Wipe the wave out.
    mode(w).queue = []
    for (const z of zombies(w)) if (z.alive) w.damage(z, 1e4, a, "rifle", a.x, a.y)
    run(w, DT * 2)
    expect(w.takeEvents().some((e) => e.k === "wave" && e.what === "clear")).toBe(true)
    expect(b.alive).toBe(true)
    expect(mode(w).state).toBe("break")
    run(w, 13)
    const z = zombies(w).find((p) => p.alive)!
    w.damage(a, 1000, z, "melee", a.x, a.y)
    w.damage(b, 1000, z, "melee", b.x, b.y)
    run(w, DT * 2)
    expect(w.phase).toBe("end")
    expect(w.mode.result(w).team).toBe(1)
  })

  test("winning the last wave wins the match", () => {
    const w = zWorld("zsv")
    const m = mode(w)
    run(w, ZOMBIE.first + 0.2)
    m.wave = 10
    m.queue = []
    for (const z of zombies(w)) z.alive = false
    run(w, DT * 2)
    expect(w.phase).toBe("end")
    expect(m.result(w).team).toBe(0)
  })

  test("zombies go with the match when the mode changes", () => {
    const w = zWorld("zsv")
    run(w, ZOMBIE.first + 2)
    expect(zombies(w).length).toBeGreaterThan(0)
    w.restart("ffa")
    expect(zombies(w).length).toBe(0)
    expect([...w.players.keys()]).toEqual(["a"])
  })

  test("bots don't count zombies as seats", () => {
    const w = zWorld("zsv")
    w.botFill = 2
    w.fill()
    run(w, ZOMBIE.first + 2)
    w.fill()
    expect([...w.players.values()].filter((p) => !p.npc).length).toBe(2)
    expect(zombies(w).length).toBeGreaterThan(0)
  })
})

describe("hold the line", () => {
  test("zombies in the zone eat its integrity; at zero the match is lost", () => {
    const w = zWorld("zhold")
    const m = w.mode as HoldTheLine
    run(w, ZOMBIE.first + 0.5)
    const zone = m.zone(w)
    const z = zombies(w).find((p) => p.alive)!
    place(w, "a", 2, 2)
    place(w, z.id, zone.x, zone.y)
    run(w, 1)
    expect(m.integrity).toBeLessThan(HOLD.integrity)
    m.integrity = 0.01
    run(w, DT * 2)
    expect(w.phase).toBe("end")
    expect(m.result(w).team).toBe(1)
  })

  test("the fallen respawn after a few seconds", () => {
    const w = zWorld("zhold")
    run(w, ZOMBIE.first + 0.5)
    const a = w.players.get("a")!
    w.damage(a, 1000, zombies(w)[0]!, "melee", a.x, a.y)
    expect(w.phase).toBe("play")
    run(w, HOLD.respawn + 0.2)
    expect(a.alive).toBe(true)
  })
})
