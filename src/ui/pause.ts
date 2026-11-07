import "./pause.css"

export type PauseActions = {
  /** Leave the match for the landing page. */
  exit(): void
  /** Room host: restart the match in the same mode, or end it now (the end screen and the vote). */
  restart(): void
  end(): void
  toggleSound(): void
  toggleMusic(): void
}

export type PauseState = { host: boolean; playing: boolean; room: string | null; sound: boolean; music: boolean; musicMode: boolean }

/** A host action needs a second click within this long. */
const CONFIRM_MS = 2000

/**
 * The Esc menu. The match keeps running underneath (it's shared), so it only takes your hands off the controls:
 * resume, sound and music, the host's restart and end, and exit to the menu.
 */
export class Pause {
  open = false
  private root: HTMLElement
  private armed: { what: string; at: number } | null = null
  /** What was last drawn; null forces a redraw. */
  private key: string | null = null

  constructor(private a: PauseActions) {
    this.root = document.createElement("div")
    this.root.id = "pause"
    document.body.appendChild(this.root)
    this.root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-pause]")
      if (t) this.act(t.dataset.pause!)
      else if (e.target === this.root) this.toggle(false)
    })
  }

  toggle(on = !this.open): void {
    this.open = on
    this.armed = null
    this.key = null
    // Closing hides it at once: after Exit to menu nothing calls update() again.
    if (!on) {
      this.root.className = ""
      this.root.innerHTML = ""
    }
  }

  private act(what: string): void {
    if (what === "resume") return this.toggle(false)
    if (what === "sound") return this.a.toggleSound()
    if (what === "music") return this.a.toggleMusic()
    if (what === "exit") {
      this.toggle(false)
      return this.a.exit()
    }
    // Restart and end are for everyone in the room: confirm with a second click.
    const now = performance.now()
    if (this.armed?.what !== what || now - this.armed.at > CONFIRM_MS) {
      this.armed = { what, at: now }
      this.key = null
      return
    }
    this.armed = null
    this.toggle(false)
    if (what === "restart") this.a.restart()
    else if (what === "end") this.a.end()
  }

  update(s: PauseState): void {
    if (this.armed && performance.now() - this.armed.at > CONFIRM_MS) this.armed = null
    const key = this.open ? JSON.stringify([s, this.armed?.what]) : ""
    if (key === this.key) return
    this.key = key
    this.root.className = this.open ? "on" : ""
    if (!this.open) {
      this.root.innerHTML = ""
      return
    }
    const armed = this.armed?.what
    const host = s.host
      ? `<div class="ph">HOST · for everyone in the room</div>
         <button class="${armed === "restart" ? "armed" : ""}" data-pause="restart">${armed === "restart" ? "CLICK AGAIN TO RESTART" : "RESTART MATCH"}</button>
         ${s.playing ? `<button class="${armed === "end" ? "armed" : ""}" data-pause="end">${armed === "end" ? "CLICK AGAIN TO END" : "END MATCH"}</button>` : ""}`
      : ""
    this.root.innerHTML = `<div class="box">
      <div class="logo small">PAUSED</div>
      <div class="sub">${s.room ? `the match keeps going · room <b>${s.room.toUpperCase()}</b>` : "the match keeps going"}</div>
      <button class="primary" data-pause="resume">RESUME <kbd>ESC</kbd></button>
      <div class="pair">
        <button data-pause="sound">SOUND ${s.sound ? "ON" : "OFF"} <kbd>M</kbd></button>
        ${s.musicMode ? `<button data-pause="music">MUSIC ${s.music ? "ON" : "OFF"}</button>` : ""}
      </div>
      ${host}
      <button class="exit" data-pause="exit">EXIT TO MENU</button>
    </div>`
  }
}
