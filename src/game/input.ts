/**
 * Keyboard and mouse. WASD or arrows move on screen axes, the mouse aims, hold Q to look further ahead, hold left
 * click to fire, hold Shift (or double-tap any of WASD / the arrows and keep moving) to sprint, R reloads, G or middle click throws
 * or plants your equipment, right click or V swings the knife, 1/2/3 pick a gun and 4/5 frag or claymore for your
 * next life, Tab shows the scores.
 */

/** Two presses of the same movement key within this long start a sprint that lasts while you keep moving. */
const DOUBLE_TAP_MS = 300
const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]
export class Input {
  private keys = new Set<string>()
  private reloadPressed = false
  private equipPressed = false
  private meleePressed = false
  mouse = { x: innerWidth / 2, y: innerHeight / 2 }
  firing = false
  /** Sprint latched by a double tap of a movement key; cleared when every movement key is let go (or by the game, once winded). */
  dash = false
  private tap = { code: "", at: -Infinity }
  enabled = false
  onKey: ((code: string) => void) | null = null

  constructor(canvas: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === "Tab") e.preventDefault()
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
      if (!e.repeat) this.onKey?.(e.code)
      this.keys.add(e.code)
      if (e.code === "KeyR") this.reloadPressed = true
      if (e.code === "KeyG" && !e.repeat) this.equipPressed = true
      if (e.code === "KeyV" && !e.repeat) this.meleePressed = true
      if (MOVE_KEYS.includes(e.code) && !e.repeat) {
        if (this.tap.code === e.code && e.timeStamp - this.tap.at < DOUBLE_TAP_MS) this.dash = true
        this.tap = { code: e.code, at: e.timeStamp }
      }
    })
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code)
      if (!MOVE_KEYS.some((k) => this.held(k))) this.dash = false
    })
    addEventListener("blur", () => {
      this.keys.clear()
      this.firing = false
      this.dash = false
    })
    addEventListener("mousemove", (e) => {
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
    })
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.firing = true
      if (e.button === 2) this.meleePressed = true
      if (e.button === 1) {
        e.preventDefault()
        this.equipPressed = true
      }
    })
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false
    })
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
  }

  /** Q held: push the camera further toward the cursor. */
  get looking(): boolean {
    return this.enabled && this.held("KeyQ")
  }

  held(code: string): boolean {
    return this.keys.has(code)
  }

  move(): { mx: number; my: number } {
    if (!this.enabled) return { mx: 0, my: 0 }
    let mx = 0
    let my = 0
    if (this.held("KeyW") || this.held("ArrowUp")) my -= 1
    if (this.held("KeyS") || this.held("ArrowDown")) my += 1
    if (this.held("KeyA") || this.held("ArrowLeft")) mx -= 1
    if (this.held("KeyD") || this.held("ArrowRight")) mx += 1
    return { mx, my }
  }

  get sprinting(): boolean {
    return this.enabled && (this.held("ShiftLeft") || this.held("ShiftRight") || this.dash)
  }

  takeEquip(): boolean {
    const r = this.equipPressed
    this.equipPressed = false
    return r && this.enabled
  }

  /** Right click or V: a knife (or claw) swing. */
  takeMelee(): boolean {
    const r = this.meleePressed
    this.meleePressed = false
    return r && this.enabled
  }

  takeReload(): boolean {
    const r = this.reloadPressed
    this.reloadPressed = false
    return r && this.enabled
  }
}
