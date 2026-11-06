import type { ModeId } from "../../shared/sim/modes"
import { FIXED_LOADOUT, INF_TEAMS, OITC } from "../../shared/sim/modes-rules"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import { type Game, css } from "../game/game"
import { INF_COLORS, ZOMBIE_COLORS } from "../game/rules-fx"
import { TEAM_COLORS } from "../game/mode-fx"
import { ZOMBIE_TEAMS, isZombieMode } from "../../shared/sim/modes-zombie"

/** HUD bits for infected, gun game and one in the chamber. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const stat = (r: RosterRow, k: string) => r.stats?.[k] ?? 0

/** Whether the mode hands out the loadout, so the gun and equipment picks are hidden. */
export const fixedLoadout = (s: Snapshot | null) => !!s && FIXED_LOADOUT.includes(s.mode.id)

/** The number on the mini leaderboard and how it ranks: score, tier or lives instead of kills. */
export function boardStat(id: ModeId): ((r: RosterRow) => number) | null {
  if (id === "inf" || isZombieMode(id)) return (r) => stat(r, "score")
  if (id === "gun") return (r) => stat(r, "tier") + 1
  if (id === "oitc") return (r) => stat(r, "lives") * 1000 + r.kills
  return null
}

/** Scoreboard columns these modes add. */
export function rulesColumns(id: ModeId): [string, (r: RosterRow) => number][] {
  if (id === "inf") return [["SCORE", (r) => stat(r, "score")]]
  if (isZombieMode(id)) return [["SCORE", (r) => stat(r, "score")]]
  if (id === "gun") return [["TIER", (r) => stat(r, "tier") + 1]]
  if (id === "oitc") return [["LIVES", (r) => stat(r, "lives")]]
  return []
}

/** Team names and colours on the scoreboard in infected. */
export const rulesTeam = (id: ModeId, t: number): { name: string; color: string } | null =>
  id === "inf" ? { name: INF_TEAMS[t] ?? "", color: css(INF_COLORS[t === 1 ? 1 : 0]) } : isZombieMode(id) ? { name: ZOMBIE_TEAMS[t] ?? "", color: css(t === 1 ? ZOMBIE_COLORS.walker! : TEAM_COLORS[0]) } : null

/** The end-screen headline for modes that read better than "X WINS", or null. */
export function rulesResult(s: Snapshot): string | null {
  const z = s.mode.zombies
  if (!z) return null
  const waves = `${z.survived} WAVE${z.survived === 1 ? "" : "S"}`
  if (!z.waves) return `SURVIVED ${waves}`
  return s.mode.winner === 0 ? `ALL ${z.waves} WAVES SURVIVED` : z.zone && z.zone.integrity <= 0 ? `THE LINE BROKE · ${waves} HELD` : `OVERRUN · ${waves} SURVIVED`
}

/** What the mode asks of you, for the intro banner. */
export function rulesObjective(s: Snapshot, team: number): string | null {
  const id = s.mode.id
  if (id === "inf") return team === 1 ? "you're infected · swipe the survivors" : "survive three minutes · one of you is about to turn"
  if (id === "gun") return "a new gun every kill · a knife kill finishes"
  if (id === "oitc") return "one bullet kills · a kill gives another · three lives"
  if (id === "zsv") return "survive ten waves together · the fallen get up when a wave is cleared"
  if (id === "zend") return "the waves never stop · how long can you last?"
  if (id === "zhold") return "keep the dead out of the zone · eight waves"
  return null
}

/** The line under the clock, or null for the usual mode HUD. */
export function rulesTop(g: Game): string | null {
  const s = g.snap
  const r = s?.mode.rules
  if (!s || (!r && !s.mode.zombies)) return null
  const me = g.roster.find((x) => x.id === g.myId)
  const z = s.mode.zombies
  if (z) {
    const wave = z.wave ? `WAVE ${z.wave}${z.waves ? `/${z.waves}` : ""}` : "GET READY"
    const what = z.state === "break" ? `NEXT WAVE IN ${Math.ceil(z.next)}` : `${z.left} ZOMBIE${z.left === 1 ? "" : "S"} LEFT`
    const zc = css(ZOMBIE_COLORS.walker!)
    let bar = ""
    if (z.zone) {
      const k = Math.max(0, Math.min(1, z.zone.integrity))
      bar = `<div class="zbar${z.zone.breached ? " hot" : ""}"><span>ZONE ${Math.ceil(k * 100)}%</span><div class="track"><i style="width:${k * 100}%"></i></div></div>`
    }
    return `<div class="scores"><span class="tgt">${wave}</span></div><div class="snd"><span class="role" style="color:${z.state === "break" ? "var(--ink)" : zc}">${what}${me ? ` · ${stat(me, "score")} PTS` : ""}</span></div>${bar}`
  }
  if (!r) return null
  if (r.id === "inf") {
    const [sc, ic] = INF_COLORS.map(css)
    const line = `<div class="scores"><b style="color:${sc}">${r.survivors}</b><span class="tgt">${r.countdown > 0 ? `TURNS IN ${Math.ceil(r.countdown)}` : "ALIVE"}</span><b style="color:${ic}">${r.infected}</b></div>`
    const role = me ? `<div class="snd"><span class="role" style="color:${me.team === 1 ? ic : sc}">${me.team === 1 ? "INFECTED" : "SURVIVOR"} · ${stat(me, "score")} PTS</span></div>` : ""
    return line + role
  }
  if (r.id === "gun") {
    const tier = me ? stat(me, "tier") : 0
    const next = r.ladder[tier + 1]
    return `<div class="scores"><span class="tgt">TIER ${tier + 1}/${r.ladder.length}</span></div><div class="snd"><span class="role">${esc(r.ladder[tier] ?? "")}${next ? ` · NEXT ${esc(next)}` : " · FINAL"}</span></div>`
  }
  const lives = me ? stat(me, "lives") : 0
  const bullets = g.alive ? g.mag : 0
  return `<div class="scores"><span class="tgt">${"●".repeat(bullets)}${"○".repeat(Math.max(0, r.max - bullets))}</span></div><div class="snd"><span class="role">${"♥".repeat(lives)}${"♡".repeat(Math.max(0, OITC.lives - lives))} · ${r.left} LEFT</span></div>`
}

/** Who won a free-for-all mode that doesn't go by kills, once it's over. */
export function rulesWinner(s: Snapshot, roster: RosterRow[]): RosterRow | null {
  const r = s.mode.rules
  return r && "winner" in r ? (roster.find((x) => x.id === r.winner) ?? null) : null
}

/** Shown while you're out for good: one in the chamber with no lives left. */
export function rulesOut(s: Snapshot): string | null {
  if (s.mode.zombies) return "back on your feet when the wave is cleared"
  return s.mode.id === "oitc" ? "out of lives" : null
}
