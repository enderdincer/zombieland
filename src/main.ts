import "./style.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import { EQUIP_IDS, type Equip, GUN_IDS, type Gun } from "../shared/config"
import { cleanName } from "../shared/protocol"
import type { Snapshot } from "../shared/sim/view"
import { DEFAULT_MODE, MODE_IDS, type ModeId, modeOf } from "../shared/sim/modes"
import { Music } from "./audio/music"
import { Sound } from "./audio/sound"
import { Game } from "./game/game"
import { Input } from "./game/input"
import { NetSession, REJOIN_KEY } from "./game/net"
import { LocalSession, type Session } from "./game/session"
import { Camera } from "./render/camera"
import { createBackend } from "./render/backend"
import { Hud } from "./ui/hud"
import { Menus } from "./ui/menus"
import { ModeHud } from "./ui/modes-hud"
import { Pause } from "./ui/pause"

const MAX_DPR = 1.5
const NAME_KEY = "blackout.name"
const GUN_KEY = "blackout.gun"
const EQUIP_KEY = "blackout.equip"
/** Volumes, 0..1, saved per browser. The old on/off music setting reads as 0 or full. */
const VOLUME_KEY = { fx: "blackout.fxVolume", music: "blackout.musicVolume" } as const
const OLD_MUSIC_KEY = "blackout.music"
const savedVolume = (kind: "fx" | "music"): number => {
  const v = Number(localStorage.getItem(VOLUME_KEY[kind]))
  if (localStorage.getItem(VOLUME_KEY[kind]) !== null && Number.isFinite(v)) return Math.max(0, Math.min(1, v))
  return kind === "music" && localStorage.getItem(OLD_MUSIC_KEY) === "off" ? 0 : kind === "music" ? 0.8 : 1
}


/**
 * How tense the zombie music should be: low between waves, rising with the dead within reach and your health
 * running out, and on edge while you're down.
 */
function threat(g: Game): number {
  const z = g.snap?.mode.zombies
  if (!z) return 0
  if (z.state === "break") return 0.12
  if (!g.alive || !g.body) return 0.45
  let near = 0
  for (const a of g.avatars.values()) if (a.alive && a.zombie && Math.hypot(a.x - g.body.x, a.y - g.body.y) < 9) near += a.zombie === "boss" ? 4 : a.zombie === "brute" ? 2 : 1
  return 0.3 + Math.min(0.5, near * 0.1) + (g.health < 50 ? 0.2 : 0)
}

/**
 * How far through the current wave (0..1), for the music's swell: the share of its zombies gone, against the most
 * seen left in it. Null between waves.
 */
let wavePeak = { n: -1, left: 1 }
function waveProgress(z: NonNullable<Snapshot["mode"]["zombies"]>): number | null {
  if (z.state !== "wave") return null
  if (wavePeak.n !== z.wave) wavePeak = { n: z.wave, left: 1 }
  wavePeak.left = Math.max(wavePeak.left, z.left)
  return 1 - z.left / wavePeak.left
}

async function main() {
  const menuEl = document.getElementById("menu")!
  const params = new URLSearchParams(location.search)
  // WebGPU where the browser has it, else WebGL2 (Firefox), else a flat 2D canvas (Mullvad, Tor). ?render= forces one.
  const force = params.get("render")
  const { backend: renderer, canvas } = await createBackend(document.getElementById("view") as HTMLCanvasElement, force === "webgpu" || force === "webgl" || force === "2d" ? force : null)
  document.documentElement.dataset.render = renderer.kind
  if (renderer.kind !== "webgpu") console.info(`[render] ${renderer.kind === "webgl" ? "WebGL2" : "2D canvas"} (no WebGPU${renderer.kind === "2d" ? " or WebGL2" : ""})`)
  const roomParam = (params.get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || null
  const storedGun = localStorage.getItem(GUN_KEY) as Gun | null
  let gun: Gun = storedGun && GUN_IDS.includes(storedGun) ? storedGun : "rifle"
  const storedEquip = localStorage.getItem(EQUIP_KEY) as Equip | null
  let equip: Equip = storedEquip && EQUIP_IDS.includes(storedEquip) ? storedEquip : "frag"
  const sound = new Sound()
  const input = new Input(canvas)
  const cam = new Camera()
  const hud = new Hud(document.getElementById("hud")!)
  const modeHud = new ModeHud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null
  let music: Music | null = null
  sound.setVolume("fx", savedVolume("fx"))
  sound.setVolume("music", savedVolume("music"))

  const begin = (name: string, s: (name: string) => Session) => {
    const clean = cleanName(name)
    localStorage.setItem(NAME_KEY, clean)
    sound.start()
    session = s(clean)
    game = new Game(renderer, session, sound)
    game.onWave = (what) => (what === "clear" ? music?.resolve() : music?.sting())
    const bus = sound.musicBus()
    if (bus && !music) music = new Music(bus.ctx, bus.out)
    menus.hide()
    hud.show(true)
  }
  const fatal = (message: string) => {
    session?.close()
    session = null
    game = null
    pause.toggle(false)
    music?.update(false, 0)
    hud.show(false)
    history.replaceState(null, "", location.pathname)
    menus.landing(null, message)
  }
  const pause = new Pause({
    exit: () => fatal(""),
    restart: () => session?.send({ type: "host", action: "reset", newFloor: true }),
    end: () => session?.send({ type: "host", action: "end" }),
    toggleSound: () => sound.setMuted(!sound.muted),
    volumes: () => ({ fx: sound.fxVolume, music: sound.musicVolume }),
    setVolume: (kind, v) => {
      sound.setVolume(kind, v)
      localStorage.setItem(VOLUME_KEY[kind], String(v))
    },
  })
  const base = location.pathname.replace(/[^/]*$/, "")
  const api = (path: string) => fetch(`${base}api/${path}`, { method: "POST" }).then((r) => r.json() as Promise<{ room: string }>)
  const enter = (name: string, room: string, priv = false, mode: ModeId | null = null) => {
    history.replaceState(null, "", `?room=${room}`)
    begin(name, (n) => new NetSession(room, n, gun, equip, fatal, priv, mode))
  }
  const vote = (mode: ModeId) => session?.send({ type: "vote", mode })
  let scores = false
  const failed = (e: unknown) => menus.landing(null, `Couldn't reach the server (${e instanceof Error ? e.message : String(e)}).`)
  const menus = new Menus(menuEl, localStorage.getItem(NAME_KEY) ?? "", {
    // Quick join finds (or starts) a public room in the picked mode.
    quick: (name, mode) => api(`quick?mode=${mode}`).then((r) => enter(name, r.room, false, mode), failed),
    create: (name, mode) => api("create").then((r) => enter(name, r.room, true, mode), failed),
    join: (name, room) => enter(name, room),
    vote,
    team: (id, team) => session?.send({ type: "team", id, team }),
    shuffle: () => session?.send({ type: "shuffle" }),
    host: (mode, newFloor) => session?.send(mode ? { type: "host", action: "mode", mode, newFloor } : { type: "host", action: "reset", newFloor }),
  })
  fetch(`${base}api/stats`)
    .then((r) => r.json() as Promise<{ players: number; games: number }>)
    .then((s) => menus.stats(s.players, s.games))
    .catch(() => {})
  input.onKey = (code) => {
    if (code === "Escape" && game) pause.toggle()
    if (pause.open) return
    if (code === "KeyM") sound.setMuted(!sound.muted)
    // T keeps the scoreboard open (the host picks teams there) until pressed again.
    if (code === "KeyT") scores = !scores
    // Between floors the number keys vote for the next mode.
    if (game?.snap?.phase === "end") {
      const v = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(code)
      const offer = game.snap.mode.votes?.options ?? MODE_IDS
      if (v >= 0 && offer[v]) vote(offer[v])
      return
    }
    const i = ["Digit1", "Digit2", "Digit3"].indexOf(code)
    if (i >= 0 && session) {
      gun = GUN_IDS[i]!
      localStorage.setItem(GUN_KEY, gun)
      session.send({ type: "gun", gun })
    }
    const e = ["Digit4", "Digit5"].indexOf(code)
    if (e >= 0 && session) {
      equip = EQUIP_IDS[e]!
      localStorage.setItem(EQUIP_KEY, equip)
      session.send({ type: "equip", equip })
    }
  }
  menus.landing(roomParam)
  // Back from a version reload: straight into the same room.
  const rejoin = sessionStorage.getItem(REJOIN_KEY)
  sessionStorage.removeItem(REJOIN_KEY)
  if (rejoin && rejoin === roomParam) enter(localStorage.getItem(NAME_KEY) ?? "", rejoin)
  // Dev and screenshots: a local match against bots, no server. Zombie modes take &wave=5 to start there.
  if (params.has("practice")) begin(localStorage.getItem(NAME_KEY) ?? "you", (n) => new LocalSession(n, gun, equip, modeOf(params.get("mode")) ?? DEFAULT_MODE, Number(params.get("wave")) || 0))

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.55, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  let last = performance.now()
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const w = innerWidth
    const h = innerHeight
    if (game && session) {
      // The Esc menu takes your hands off the controls; the match carries on.
      input.enabled = game.snap?.phase === "play" && !pause.open
      game.update(dt, input, cam, w, h, now)
      const body = game.body ? game.drawn : null
      const alive = game.alive
      // Out for the round in search and destroy: watch a teammate.
      const spec = modeHud.spectate(game)
      const fx = spec?.x ?? body?.x ?? game.map.size[0] / 2
      const fz = spec?.y ?? body?.y ?? game.map.size[1] / 2
      // Look-ahead: the view leans toward the cursor; holding Q leans much further (scouting, sniping).
      const far = input.looking && alive
      const k = far ? 0.65 : 0.35
      const cap = far ? 11 : 5
      const lx = alive && body ? Math.max(-cap, Math.min(cap, (game.cursor.x - body.x) * k)) : 0
      const lz = alive && body ? Math.max(-cap * 0.7, Math.min(cap * 0.7, (game.cursor.y - body.y) * k)) : 0
      cam.follow(fx, fz, lx, lz, dt, !body)
      renderer.render(game.build(cam, w, h, dt))
      hud.update(game, cam, w, h, input.mouse, session.status())
      modeHud.update(game, cam, w, h)
      menus.update(game.snap, game.roster, session.myId, session.room, input.held("Tab") || scores, (id) => game!.colorOf(id))
      const zv = game.snap?.mode.zombies
      pause.update({ host: !!game.roster.find((r) => r.id === session!.myId)?.host, playing: game.snap?.phase === "play", room: session.room, sound: !sound.muted, musicMode: !!zv })
      music?.update(sound.musicVolume > 0 && !!zv && game.snap?.phase === "play", zv ? threat(game) : 0, zv ? waveProgress(zv) : null)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
