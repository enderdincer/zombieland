// A standalone server for running BLACKOUT outside Cloudflare (Docker, Kubernetes): the same rooms (RoomCore) and
// matchmaking (Matchmaker) the Durable Objects run, held in this one process, plus the built client from STATIC_DIR.
// Rooms live in memory, so run exactly one replica; a restart ends the matches in progress.
//
//   bun run build && bun server/bun.ts          (PORT=8080 STATIC_DIR=dist/labs/blackout by default)
import { join, normalize } from "node:path"
import type { ServerWebSocket } from "bun"
import { modeOf } from "../shared/sim/modes"
import { Matchmaker } from "./matchmaking"
import { type Conn, MAX_CATCHUP, RoomCore, TICK_MS } from "./room-core"

const PORT = Number(process.env.PORT ?? 8080)
const STATIC_DIR = normalize(process.env.STATIC_DIR ?? join(import.meta.dir, "../dist/labs/blackout"))
/** Lobby reports: at most one per second per room, and a heartbeat inside the Matchmaker's stale window. */
const REPORT_MIN_MS = 1000
const HEARTBEAT_MS = 10_000

const lobby = new Matchmaker()

/** One room: its game, its tick loop while anyone's connected, and what it last told the lobby. */
class Room {
  core: RoomCore
  priv = false
  /** Open sockets, counted from the upgrade: a player whose hello is still on its way keeps the room alive too. */
  sockets = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0
  private reported = ""
  private reportAt = 0

  constructor(readonly code: string) {
    this.core = new RoomCore(code)
  }

  /** The first arrival in an empty room picks its mode and whether it's private, as on the Durable Object. */
  arrive(url: URL): void {
    if (this.sockets > 0) return
    const mode = modeOf(url.searchParams.get("mode"))
    if (mode) this.core.setMode(mode)
    if (url.searchParams.get("private") === "1") this.priv = true
  }

  start(): void {
    this.sockets++
    if (this.timer) return
    this.clock = Date.now()
    this.timer = setInterval(() => this.loop(), TICK_MS)
  }

  private loop(): void {
    if (this.sockets === 0) {
      clearInterval(this.timer!)
      this.timer = null
      this.report(true)
      // Nobody left: the next visitor gets a fresh room.
      rooms.delete(this.code)
      return
    }
    const now = Date.now()
    let due = Math.floor((now - this.clock) / TICK_MS)
    if (due > MAX_CATCHUP) {
      this.clock = now - MAX_CATCHUP * TICK_MS
      due = MAX_CATCHUP
    }
    for (let i = 0; i < due; i++) this.core.step()
    this.clock += due * TICK_MS
    this.report(false)
  }

  private report(force: boolean): void {
    const w = this.core.world
    const players = this.core.connections === 0 ? 0 : w.humans.length
    const key = `${players}|${w.phase}|${this.priv}|${w.mode.id}`
    const now = Date.now()
    if (!force && (now - this.reportAt < REPORT_MIN_MS || (key === this.reported && now - this.reportAt < HEARTBEAT_MS))) return
    this.reported = key
    this.reportAt = now
    lobby.report({ code: this.code, players, phase: w.phase, private: this.priv, mode: w.mode.id }, now)
  }
}

const rooms = new Map<string, Room>()

type Socket = { room: Room; conn: Conn | null }

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } })

/** A file from the built client, never outside STATIC_DIR. Hashed assets cache for a year; pages revalidate. */
async function asset(path: string): Promise<Response> {
  const rel = path === "/" || path === "" ? "/index.html" : path
  const file = normalize(join(STATIC_DIR, decodeURIComponent(rel)))
  if (!file.startsWith(STATIC_DIR)) return new Response("not found", { status: 404 })
  const f = Bun.file(file)
  if (!(await f.exists())) return new Response("not found", { status: 404 })
  const immutable = rel.startsWith("/assets/")
  return new Response(f, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } })
}

const server = Bun.serve<Socket, never>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url)
    // Same routes as the Worker, with or without the /labs/blackout prefix it's deployed under there.
    const path = url.pathname.replace(/^\/labs\/blackout(?=\/|$)/, "")
    const now = Date.now()
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
    if (path === "/api/quick") return json({ room: lobby.quick(now) })
    if (path === "/api/create") return json({ room: lobby.create(now) })
    if (path === "/api/stats") return json(lobby.stats(now))
    const ws = path.match(/^\/ws\/([a-z0-9]{4,8})\/?$/)
    if (ws) {
      const code = ws[1]!
      let room = rooms.get(code)
      if (!room) rooms.set(code, (room = new Room(code)))
      room.arrive(url)
      if (srv.upgrade(req, { data: { room, conn: null } })) return undefined
      return new Response("expected websocket", { status: 426 })
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("not found", { status: 404 })
    return asset(path)
  },
  websocket: {
    open(ws: ServerWebSocket<Socket>) {
      const conn: Conn = {
        send(data) {
          ws.send(data)
        },
        close(code, reason) {
          ws.close(code, reason)
        },
      }
      ws.data.conn = conn
      ws.data.room.start()
    },
    message(ws: ServerWebSocket<Socket>, msg) {
      if (ws.data.conn) ws.data.room.core.message(ws.data.conn, typeof msg === "string" ? msg : msg.toString())
    },
    close(ws: ServerWebSocket<Socket>) {
      if (ws.data.conn) ws.data.room.core.close(ws.data.conn)
      ws.data.room.sockets--
    },
  },
})

console.log(`blackout on :${server.port}, client from ${STATIC_DIR}`)
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0))
