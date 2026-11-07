import { DurableObject } from "cloudflare:workers"
import { DEFAULT_MODE, type ModeId, modeOf } from "../shared/sim/modes"
import { type Env, lobbyOf } from "./env"
import { type Conn, MAX_CATCHUP, RoomCore, TICK_MS } from "./room-core"

export { type Conn, IDLE_KICK_MS, IDLE_WARN_MS, RoomCore } from "./room-core"

/** Lobby reports: at most one per second, and a heartbeat well inside the Lobby's stale window. */
const REPORT_MIN_MS = 1000
const HEARTBEAT_MS = 10_000

/** One Durable Object per room code. Ticks while anyone is connected and reports its seats to the Lobby. */
export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0
  /** Made with "Create game" (reported to the Lobby; quick join still finds the room once people are in it). */
  private priv: boolean | null = null
  /** The mode the room was created with, for the first match whenever the room starts up again. */
  private mode: ModeId | null = null
  private reported = ""
  private reportAt = 0

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const code = req.headers.get("x-room")
    if (!code) return new Response("missing room", { status: 400 })
    this.mode ??= modeOf(await this.ctx.storage.get<string>("mode")) ?? DEFAULT_MODE
    const core = (this.core ??= new RoomCore(code, this.mode))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    // Likewise only the first arrival picks the mode (Create game sends it).
    const mode = modeOf(new URL(req.url).searchParams.get("mode"))
    if (mode && core.connections === 0 && core.setMode(mode)) {
      this.mode = mode
      await this.ctx.storage.put("mode", mode)
    }
    // Only the first arrival in an empty room can make it private, so a link can't hide an existing public room.
    if (!this.priv && core.connections === 0 && new URL(req.url).searchParams.get("private") === "1") {
      this.priv = true
      await this.ctx.storage.put("private", true)
    }
    const pair = new WebSocketPair()
    const socket = pair[1]
    socket.accept()
    const conn: Conn = {
      send(data) {
        try {
          socket.send(data)
        } catch {}
      },
      close(c, reason) {
        try {
          socket.close(c, reason)
        } catch {}
      },
    }
    socket.addEventListener("message", (e) => core.message(conn, e.data))
    socket.addEventListener("close", () => core.close(conn))
    socket.addEventListener("error", () => core.close(conn))
    if (!this.timer) {
      this.clock = Date.now()
      this.timer = setInterval(() => this.loop(), TICK_MS)
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private loop(): void {
    const core = this.core!
    if (core.connections === 0) {
      clearInterval(this.timer!)
      this.timer = null
      this.report(core, true)
      // Nobody left: the next visitor gets a fresh room.
      this.core = null
      return
    }
    const now = Date.now()
    let due = Math.floor((now - this.clock) / TICK_MS)
    if (due > MAX_CATCHUP) {
      this.clock = now - MAX_CATCHUP * TICK_MS
      due = MAX_CATCHUP
    }
    for (let i = 0; i < due; i++) core.step()
    this.clock += due * TICK_MS
    this.report(core, false)
  }

  /** Tells the Lobby our human count and phase when they change (throttled), plus a heartbeat. Fire-and-forget. */
  private report(core: RoomCore, force: boolean): void {
    const players = core.connections === 0 ? 0 : core.world.humans.length
    const phase = core.world.phase
    const priv = !!this.priv
    const mode = core.world.mode.id
    const key = `${players}|${phase}|${priv}|${mode}`
    const now = Date.now()
    if (!force && (now - this.reportAt < REPORT_MIN_MS || (key === this.reported && now - this.reportAt < HEARTBEAT_MS))) return
    this.reported = key
    this.reportAt = now
    lobbyOf(this.env)
      .report({ code: core.code, players, phase, private: priv, mode })
      .then(undefined, () => (this.reported = ""))
  }
}
