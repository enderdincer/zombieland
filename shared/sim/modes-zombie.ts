import { DT, type Gun, HEALTH } from "../config"
import { type Vec, angleDiff, clearLine } from "../geom"
import { Rng } from "../rng"
import { type Kit, bareKit, gunKit } from "./kit"
import { MELEE } from "./melee"
import { type Goal, MODE_FACTORIES, Mode, type ModeId } from "./modes"
import { navFor } from "./nav"
import { placesFor } from "./places"
import type { Brain, Intent, Player, World } from "./world"

/**
 * Zombie modes: co-op against waves of the dead. The survivors (team 0) are the players and, in practice, bots; the
 * zombies (team 1) are players the mode runs itself (Player.npc, their kind), spawned out of sight, walking a path to
 * the nearest survivor and swiping when they get there. A wave is cleared when everything in it is dead; then a short
 * break, and the next one is bigger, tougher and faster.
 *
 * Survival: ten waves, the fallen are down until the wave is cleared. Endless night: the same with no last wave and a
 * steeper climb. Hold the line: the horde goes for a zone and eats its integrity; you respawn, the zone doesn't.
 */

export const ZOMBIE_MODES: readonly ModeId[] = ["zsv", "zend", "zhold"]
export const isZombieMode = (id: ModeId): boolean => ZOMBIE_MODES.includes(id)
export const ZOMBIE_TEAMS = ["SURVIVORS", "ZOMBIES"] as const

export type ZombieKind = "walker" | "runner" | "sprinter" | "brute" | "boss"

/**
 * Per kind: health, walking speed (m/s; you walk 4.2 and sprint 6.3), the swipe (damage, wind-up, cooldown, reach),
 * the points a kill is worth, and how fast it eats a zone's integrity (per second, standing in it).
 */
export const ZOMBIES: Record<ZombieKind, { label: string; health: number; walk: number; damage: number; windup: number; cooldown: number; range: number; score: number; gnaw: number }> = {
  walker: { label: "ZOMBIE", health: 100, walk: 1.7, damage: 25, windup: 0.35, cooldown: 1.1, range: 1.4, score: 10, gnaw: 0.5 },
  runner: { label: "RUNNER", health: 60, walk: 3.9, damage: 15, windup: 0.25, cooldown: 0.8, range: 1.3, score: 15, gnaw: 0.35 },
  // Quicker than a runner and faster than you walk, so you sprint or you shoot; a couple of rifle hits drop it.
  sprinter: { label: "SPRINTER", health: 35, walk: 4.6, damage: 12, windup: 0.2, cooldown: 0.6, range: 1.3, score: 20, gnaw: 0.3 },
  // Every fifth wave ends with a boss: a hulk that soaks up a whole team's fire, with a long, crushing reach.
  boss: { label: "BOSS", health: 2400, walk: 1.5, damage: 70, windup: 0.6, cooldown: 1.8, range: 2.2, score: 300, gnaw: 6 },
  brute: { label: "BRUTE", health: 450, walk: 1.35, damage: 45, windup: 0.5, cooldown: 1.6, range: 1.8, score: 60, gnaw: 2 },
}

/**
 * The break before the first wave, seconds between spawns (from `spawnSlow` in wave one down to `spawnFast`), how far
 * from every survivor a zombie spawns, the most alive at once, the knife (V) against the dead, and the backstop clock.
 */
export const ZOMBIE = { first: 10, spawnSlow: 1.1, spawnFast: 0.35, spawnMin: 11, maxAlive: 28, knife: 75, seconds: 3600, swap: 0.45, refill: 20, equipMax: 2 }

/** How many can be up at once in wave `n` for `survivors`: a few at first, more as the waves climb. */
export const aliveCap = (n: number, survivors: number) => Math.min(ZOMBIE.maxAlive, 4 + 2 * Math.max(1, survivors) + n)
/** Hold the line: the zone's radius, its integrity, what clearing a wave repairs, and how soon the fallen respawn. */
export const HOLD = { radius: 3.5, integrity: 100, repair: 15, respawn: 5 }

/** Per mode: waves to win (0 for endless), the break between waves, and how fast the waves climb. */
type Tuning = { waves: number; rest: number; hp: number; speed: number; runners: number; sprinters: number; brutes: number }
const TUNING: Record<"zsv" | "zend" | "zhold", Tuning> = {
  zsv: { waves: 10, rest: 12, hp: 0.1, speed: 0.02, runners: 3, sprinters: 4, brutes: 5 },
  zend: { waves: 0, rest: 8, hp: 0.15, speed: 0.03, runners: 2, sprinters: 3, brutes: 4 },
  zhold: { waves: 8, rest: 12, hp: 0.1, speed: 0.02, runners: 3, sprinters: 4, brutes: 5 },
}

export type ZombieView = {
  wave: number
  /** Waves to win; 0 for endless. */
  waves: number
  state: "break" | "wave"
  /** Seconds to the next wave during a break. */
  next: number
  /** Zombies still to come this wave, alive or not yet spawned. */
  left: number
  /** Hold the line: the zone and its integrity (0..1). */
  zone: { x: number; y: number; r: number; integrity: number; breached: boolean } | null
  /** Once it's over: the last wave cleared, and how it ended. */
  survived: number
  why: "" | "won" | "overrun" | "breach" | "ended"
  /** Seconds until your equipment gets another charge; 0 when it's full. */
  refill: number
}

/** The zombies in wave `n` for `survivors` players: walkers, runners from a few waves in, brutes later, a horde of them every fifth. */
export function waveOf(n: number, survivors: number, t: Tuning, rng: Rng): ZombieKind[] {
  const s = Math.max(1, survivors)
  const total = Math.min(90, Math.round((3 + 2.5 * n) * (0.6 + 0.4 * s)))
  const runners = n >= t.runners ? Math.floor(total * Math.min(0.4, 0.08 * (n - t.runners + 1))) : 0
  const sprinters = n >= t.sprinters ? Math.max(1, Math.floor(total * Math.min(0.2, 0.05 * (n - t.sprinters + 1)))) : 0
  const brutes = n >= t.brutes ? Math.floor((n - t.brutes) / 2) + 1 + (n % 5 === 0 ? Math.ceil(s / 2) : 0) : 0
  const out: ZombieKind[] = []
  for (let i = 0; i < total - runners - sprinters; i++) out.push("walker")
  for (let i = 0; i < runners; i++) out.push("runner")
  for (let i = 0; i < sprinters; i++) out.push("sprinter")
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  // Brutes come late in the wave, spread through its second half.
  for (let i = 0; i < brutes; i++) out.splice(Math.floor(out.length * (0.5 + 0.5 * rng.next())), 0, "brute")
  // Boss waves: one boss (two from four survivors, three from seven) three quarters of the way through.
  if (n % 5 === 0) for (let i = 0; i < 1 + Math.floor((s - 1) / 3); i++) out.splice(Math.floor(out.length * 0.75), 0, "boss")
  return out
}

const stat = (p: Player, k: string) => p.stats[k] ?? 0
const add = (p: Player, k: string, n: number) => {
  p.stats[k] = stat(p, k) + n
}
/** The big ones: brutes and bosses hang their arms low, smash overhead and groan deep. */
export const heavy = (kind: string): boolean => kind === "brute" || kind === "boss"
export const kindOf = (p: Player): ZombieKind | null => (p.npc in ZOMBIES ? (p.npc as ZombieKind) : null)

export class ZombieMode extends Mode {
  override readonly id: ModeId = "zsv"
  wave = 0
  state: "break" | "wave" = "break"
  /** When the break ends, and when the wave started. */
  private nextAt = 0
  private waveAt = 0
  /** Who's left to spawn this wave, and when the next can. */
  queue: ZombieKind[] = []
  private spawnNext = 0
  private made = 0
  /** Hold the line's zone integrity, 0..HOLD.integrity. */
  integrity: number = HOLD.integrity
  lost = false
  won = false
  /** Each survivor's rounds left in the guns they're not holding, so a swap is no free reload. */
  private mags = new Map<string, Partial<Record<Gun, number>>>()
  /** When each survivor's equipment gets its next charge. */
  private refillAt = new Map<string, number>()

  protected get tune(): Tuning {
    return TUNING[this.id as keyof typeof TUNING] ?? TUNING.zsv
  }

  override get seconds(): number {
    return ZOMBIE.seconds
  }

  /** Hold the line keeps a zone; the others don't. */
  protected get holds(): boolean {
    return this.id === "zhold"
  }

  zone(w: World): Vec {
    return placesFor(w.map).points[1]
  }

  override start(w: World): void {
    this.score = [0, 0]
    this.wave = 0
    this.state = "break"
    this.nextAt = w.time + ZOMBIE.first
    this.queue = []
    this.integrity = HOLD.integrity
    this.lost = false
    this.won = false
    this.mags.clear()
    this.refillAt.clear()
    for (const p of w.players.values()) {
      p.team = 0
      p.stats.score = 0
    }
    for (const p of w.players.values()) w.spawn(p)
  }

  /** Everyone who joins is a survivor, in the fight right away. */
  override join(_w: World, p: Player): boolean {
    p.team = p.npc ? 1 : 0
    p.stats.score ??= 0
    return true
  }

  override loadout(w: World, p: Player): Kit {
    const kind = kindOf(p)
    if (kind) {
      const z = ZOMBIES[kind]
      const k = this.wave - 1
      const walk = z.walk * Math.min(1.35, 1 + this.tune.speed * k) * (0.9 + 0.2 * w.rng.next())
      return bareKit({ id: `z-${kind}`, label: z.label, walk, run: walk, regen: false, health: Math.round(z.health * (1 + this.tune.hp * k)), swing: { damage: z.damage, windup: z.windup, cooldown: z.cooldown, range: z.range } })
    }
    // A new life: every gun starts full again.
    this.mags.delete(p.id)
    this.refillAt.delete(p.id)
    return this.survivorKit(p)
  }

  /** Your pick of gun and equipment, and the knife, which hurts the dead badly. */
  private survivorKit(p: Player): Kit {
    return gunKit(p.pick, p.equipPick, { melee: true, swing: { damage: ZOMBIE.knife, windup: MELEE.windup, cooldown: MELEE.cooldown, range: MELEE.range } })
  }

  /**
   * Swapping guns mid-life: the new one comes up after a moment, with whatever was left in it (full the first time).
   * A reload in progress is lost. Your equipment stays as it is.
   */
  override swap(w: World, p: Player): void {
    if (p.npc) return
    const mags = this.mags.get(p.id) ?? {}
    mags[p.gun] = p.mag
    this.mags.set(p.id, mags)
    const equip = p.equip
    const left = p.equipLeft
    const kit = this.survivorKit(p)
    w.arm(p, kit)
    p.mag = mags[kit.gun!] ?? kit.mag
    p.equip = equip
    p.equipLeft = left
    p.readyAt = w.time + ZOMBIE.swap
  }

  /** Survivors short of equipment get a charge back every ZOMBIE.refill seconds, up to ZOMBIE.equipMax. */
  private refill(w: World): void {
    for (const p of this.members(w, 0)) {
      if (!p.alive || p.equipLeft >= ZOMBIE.equipMax) {
        this.refillAt.delete(p.id)
        continue
      }
      const at = this.refillAt.get(p.id)
      if (at === undefined) this.refillAt.set(p.id, w.time + ZOMBIE.refill)
      else if (w.time >= at) {
        p.equipLeft++
        this.refillAt.set(p.id, w.time + ZOMBIE.refill)
      }
    }
  }

  /**
   * Survivors start together in the middle of the floor, in the offices rather than up against the outer glass with
   * the city below filling the view, and get up next to someone still standing. Zombies spawn away from everyone
   * (zombieSpot).
   */
  override spawnAt(w: World, p: Player): Vec | null {
    if (p.npc) return this.zombieSpot(w)
    const standing = this.members(w, 0).filter((q) => q.alive && q !== p)
    if (this.holds || this.wave === 0 || !standing.length) return this.midSlot(w, p)
    return this.near(w, w.rng.pick(standing))
  }

  /** A spot around the middle of the floor (domination's B, the zone): the centre, then rings at 1.2 m and 2.4 m. */
  private midSlot(w: World, p: Player): Vec {
    const c = this.zone(w)
    const nav = navFor(w.map)
    const spots: Vec[] = [c]
    for (const r of [1.2, 2.4])
      for (let i = 0; i < 8; i++) {
        const v = { x: c.x + Math.cos((i / 8) * Math.PI * 2 + r) * r, y: c.y + Math.sin((i / 8) * Math.PI * 2 + r) * r }
        if (nav.walkable(v) && clearLine(c.x, c.y, v.x, v.y, w.solids)) spots.push(v)
      }
    const i = Math.max(0, this.members(w, 0).indexOf(p))
    return spots[i % spots.length]!
  }

  /** The map spawn nearest to `at`. */
  private near(w: World, at: Vec): Vec {
    let best = w.map.spawns[0]!
    let bd = Infinity
    for (const s of placesFor(w.map).halves.flat()) {
      const d = Math.hypot(s.x - at.x, s.y - at.y)
      if (d < bd) {
        bd = d
        best = s
      }
    }
    return best
  }

  /** A spawn at least ZOMBIE.spawnMin from every survivor, out of their sight if possible; else the farthest. */
  private zombieSpot(w: World): Vec {
    const living = this.members(w, 0).filter((q) => q.alive)
    const spots = placesFor(w.map).halves.flat()
    let best = spots[0] ?? w.map.spawns[0]!
    let bs = -Infinity
    for (const s of spots) {
      const d = living.length ? Math.min(...living.map((q) => Math.hypot(q.x - s.x, q.y - s.y))) : 20
      const seen = living.some((q) => clearLine(q.x, q.y, s.x, s.y, w.blockers))
      const sc = (d >= ZOMBIE.spawnMin ? 100 : d) - (seen ? 40 : 0) - Math.max(0, d - 30) * 0.5 + w.rng.next() * 25
      if (sc > bs) {
        bs = sc
        best = s
      }
    }
    // A little jitter so a pack from the same door doesn't stack.
    const j = { x: best.x + (w.rng.next() - 0.5) * 0.8, y: best.y + (w.rng.next() - 0.5) * 0.8 }
    return navFor(w.map).walkable(j) ? j : best
  }

  /** Spawns the next zombie of the wave, reusing one that's been dead a while (its corpse gone) before making one. */
  private spawnZombie(w: World, kind: ZombieKind): void {
    let z = [...w.players.values()].find((p) => p.npc && !p.alive && w.time - p.hurtAt > 4)
    if (!z) z = w.addNpc(`z${++this.made}`, ZOMBIES[kind].label, kind, new ZombieBrain(w.rng.next() * 1e9))
    z.npc = kind
    z.name = ZOMBIES[kind].label
    z.team = 1
    w.spawn(z)
    if (kind === "boss") w.events.push({ k: "wave", what: "boss", n: this.wave })
  }

  override killed(w: World, victim: Player, killer: Player): void {
    const kind = kindOf(victim)
    if (kind) {
      victim.respawnAt = Infinity
      if (!killer.npc) add(killer, "score", ZOMBIES[kind].score)
      return
    }
    // The fallen are down until the wave is cleared; holding the line, they're back in a few seconds.
    victim.respawnAt = this.holds ? w.time + HOLD.respawn : Infinity
  }

  /** Every survivor up again: the fallen get up, the standing are patched up and get their equipment back. */
  private regroup(w: World): void {
    for (const p of this.members(w, 0)) {
      if (!p.alive) w.spawn(p)
      else {
        p.health = HEALTH
        p.equipLeft = Math.max(p.equipLeft, p.kit.equip ? p.kit.equipCount : 0)
      }
    }
  }

  private zombies(w: World): Player[] {
    return [...w.players.values()].filter((p) => p.npc && p.alive)
  }

  override step(w: World): void {
    const survivors = this.members(w, 0)
    this.refill(w)
    if (this.state === "break") {
      if (w.time >= this.nextAt) {
        this.wave++
        this.state = "wave"
        this.waveAt = w.time
        this.queue = waveOf(this.wave, survivors.length, this.tune, w.rng)
        this.spawnNext = w.time
        w.events.push({ k: "wave", what: "start", n: this.wave })
      }
    } else {
      const alive = this.zombies(w)
      if (this.queue.length && alive.length < aliveCap(this.wave, survivors.length) && w.time >= this.spawnNext) {
        this.spawnZombie(w, this.queue.shift()!)
        this.spawnNext = w.time + Math.max(ZOMBIE.spawnFast, ZOMBIE.spawnSlow - 0.08 * (this.wave - 1))
      }
      if (this.holds) {
        const z = this.zone(w)
        for (const q of alive) if (Math.hypot(q.x - z.x, q.y - z.y) <= HOLD.radius) this.integrity -= ZOMBIES[kindOf(q) ?? "walker"].gnaw * DT
        if (this.integrity <= 0) {
          this.integrity = 0
          this.lost = true
          return w.endMatch()
        }
      }
      if (!this.queue.length && !alive.length) {
        w.events.push({ k: "wave", what: "clear", n: this.wave })
        if (this.tune.waves && this.wave >= this.tune.waves) {
          this.won = true
          return w.endMatch()
        }
        this.state = "break"
        this.nextAt = w.time + this.tune.rest
        if (this.holds) this.integrity = Math.min(HOLD.integrity, this.integrity + HOLD.repair)
        this.regroup(w)
      }
    }
    // Everyone down at once (nobody left to clear the wave): the dead win.
    if (survivors.length && !survivors.some((p) => p.alive) && !this.holds) {
      this.lost = true
      return w.endMatch()
    }
    this.score = [this.wave, this.queue.length + this.zombies(w).length]
  }

  /** Waves cleared so far. */
  get survived(): number {
    return this.state === "break" || (!this.lost && this.tune.waves > 0 && this.wave >= this.tune.waves) ? this.wave : this.wave - 1
  }

  override result(w: World): { winner: string; team: number } {
    const ranked = this.members(w, 0).sort((a, b) => stat(b, "score") - stat(a, "score") || b.kills - a.kills)
    return { winner: ranked[0]?.id ?? "", team: this.won ? 0 : 1 }
  }

  override left(w: World): number {
    return this.state === "break" ? Math.max(0, this.nextAt - w.time) : w.time - this.waveAt
  }

  override target(): number {
    return this.tune.waves
  }

  /** Holding the line, bots and zombies alike head for the zone; otherwise they hunt. */
  override botGoal(w: World, _p: Player): Goal | null {
    return this.holds ? { ...this.zone(w), use: false } : null
  }

  override view(w: World, viewer: string) {
    const z = this.zone(w)
    const breached = this.holds && this.zombies(w).some((q) => Math.hypot(q.x - z.x, q.y - z.y) <= HOLD.radius)
    const zombies: ZombieView = {
      wave: this.wave,
      waves: this.tune.waves,
      state: this.state,
      next: this.state === "break" ? Math.max(0, this.nextAt - w.time) : 0,
      left: this.queue.length + this.zombies(w).length,
      zone: this.holds ? { x: z.x, y: z.y, r: HOLD.radius, integrity: this.integrity / HOLD.integrity, breached } : null,
      survived: Math.max(0, this.survived),
      why: w.phase !== "end" ? "" : this.won ? "won" : this.lost ? (this.holds ? "breach" : "overrun") : "ended",
      refill: Math.max(0, (this.refillAt.get(viewer) ?? w.time) - w.time),
    }
    return { ...super.view(w, viewer), zombies }
  }
}

export class EndlessNight extends ZombieMode {
  override readonly id: ModeId = "zend"
}

export class HoldTheLine extends ZombieMode {
  override readonly id: ModeId = "zhold"
}

/**
 * A zombie: shambles toward the nearest survivor it can reach (straight at them in the open, else along a path), keeps
 * a little apart from the rest of the horde, and swipes once in reach. When the mode has a goal (the zone), it goes
 * there and only turns on survivors who come close.
 */
export class ZombieBrain implements Brain {
  private rng: Rng
  private path: Vec[] = []
  private repathAt = 0
  private dest: Vec | null = null
  private aim = 0
  private sway: number

  constructor(seed: number) {
    this.rng = new Rng(seed)
    this.sway = this.rng.next() * 6.28
  }

  think(w: World, p: Player): Intent {
    const i: Intent = { mx: 0, my: 0, aim: this.aim, fire: false, reload: false, sprint: false, equip: false, tx: 0, ty: 0, use: false }
    let near: Player | null = null
    let nd = Infinity
    for (const q of w.players.values()) {
      if (!q.alive || q.npc || w.allies(p, q)) continue
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < nd) {
        nd = d
        near = q
      }
    }
    const goal = w.mode.botGoal(w, p)
    const sees = !!near && nd < 14 && clearLine(p.x, p.y, near.x, near.y, w.solids)
    // Holding the line the zone comes first, unless someone is right there.
    const chase = near && (!goal || (sees && nd < 5)) ? near : null
    const dest: Vec | null = chase ?? goal
    if (!dest) return i
    const dd = Math.hypot(dest.x - p.x, dest.y - p.y)
    let dir: Vec | null = null
    if (chase && sees) dir = { x: (chase.x - p.x) / (nd || 1), y: (chase.y - p.y) / (nd || 1) }
    else if (dd > 1) dir = this.toward(w, p, dest)
    if (dir) {
      // Shuffle: a slow sway across the line of travel, and push off any zombie too close.
      const sway = Math.sin(w.time * 1.7 + this.sway) * 0.25
      let mx = dir.x - dir.y * sway
      let my = dir.y + dir.x * sway
      for (const q of w.players.values()) {
        if (q === p || !q.alive || !q.npc) continue
        const dx = p.x - q.x
        const dy = p.y - q.y
        const d = Math.hypot(dx, dy)
        if (d > 0.01 && d < 0.75) {
          mx += (dx / d) * (0.75 - d) * 2.5
          my += (dy / d) * (0.75 - d) * 2.5
        }
      }
      const m = Math.hypot(mx, my) || 1
      i.mx = mx / m
      i.my = my / m
    }
    const want = chase && nd < 3 ? Math.atan2(chase.y - p.y, chase.x - p.x) : dir ? Math.atan2(dir.y, dir.x) : this.aim
    this.aim += Math.max(-0.25, Math.min(0.25, angleDiff(want, this.aim)))
    i.aim = this.aim
    const reach = p.kit.swing?.range ?? MELEE.range
    if (chase && nd < reach * 0.9 && Math.abs(angleDiff(this.aim, want)) < 0.7 && clearLine(p.x, p.y, chase.x, chase.y, w.blockers)) {
      i.fire = true
      // Slow down to land it.
      i.mx *= 0.3
      i.my *= 0.3
    } else if (!chase && goal && dd < HOLD.radius && this.rng.next() < 0.02) i.fire = true
    return i
  }

  /** The unit step along a path to `dest`, repathing every second or two (or when it moves); null once there. */
  private toward(w: World, p: Player, dest: Vec): Vec | null {
    const now = w.time
    const moved = !this.dest || Math.hypot(this.dest.x - dest.x, this.dest.y - dest.y) > 2
    if (now >= this.repathAt || !this.path.length || moved) {
      this.path = navFor(w.map).path(p, dest) ?? []
      this.dest = { x: dest.x, y: dest.y }
      this.repathAt = now + 1.2 + this.rng.next()
    }
    while (this.path.length && Math.hypot(this.path[0]!.x - p.x, this.path[0]!.y - p.y) < 0.35) this.path.shift()
    const next = this.path[0]
    if (!next) return null
    const d = Math.hypot(next.x - p.x, next.y - p.y)
    return { x: (next.x - p.x) / d, y: (next.y - p.y) / d }
  }
}

MODE_FACTORIES.zsv = () => new ZombieMode()
MODE_FACTORIES.zend = () => new EndlessNight()
MODE_FACTORIES.zhold = () => new HoldTheLine()
