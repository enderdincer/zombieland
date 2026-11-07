import type { MapDef } from "../../shared/maps"
import { Canvas2dRenderer } from "./canvas2d"
import { GlRenderer } from "./gl/renderer-gl"
import type { LevelData } from "./level-mesh"
import type { Mesh } from "./mesh"
import { type FrameInput, Renderer } from "./renderer"

/**
 * What the game draws through: WebGPU (the full look), WebGL2 (the same look, for browsers without WebGPU, such as
 * Firefox) or a flat 2D canvas (for browsers with no GPU access at all, such as Mullvad and Tor by default).
 */
export interface RenderBackend {
  readonly kind: "webgpu" | "webgl" | "2d"
  width: number
  height: number
  drawnChunks: number
  addModel(mesh: Mesh): number
  /** The floor's meshes; the 2D canvas draws from `map` instead. */
  setLevel(level: LevelData, map?: MapDef): void
  resize(w: number, h: number): void
  render(f: FrameInput): void
}

export type BackendKind = RenderBackend["kind"]

/**
 * The best backend the browser offers: WebGPU, else WebGL2 (with float render targets), else the 2D canvas. `force`
 * (?render=webgl or 2d) skips the better ones, for testing. A canvas can only ever hold one kind of context, so a
 * WebGL2 context that turns out unusable means a fresh canvas for the 2D one; the canvas in use is returned.
 */
export async function createBackend(canvas: HTMLCanvasElement, force: BackendKind | null): Promise<{ backend: RenderBackend; canvas: HTMLCanvasElement }> {
  if (!force || force === "webgpu") {
    const gpu = await webgpu(canvas)
    if (gpu) return { backend: gpu, canvas }
  }
  if (force !== "2d") {
    const gl = GlRenderer.create(canvas)
    if (gl) return { backend: gl, canvas }
    // A WebGL2 context may have been created and found wanting: start the 2D canvas on a fresh element.
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement
    canvas.replaceWith(fresh)
    canvas = fresh
  }
  return { backend: new Canvas2dRenderer(canvas.getContext("2d")!), canvas }
}

async function webgpu(canvas: HTMLCanvasElement): Promise<Renderer | null> {
  try {
    if (!navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
    if (!adapter) return null
    const device = await adapter.requestDevice()
    device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
    const context = canvas.getContext("webgpu")
    if (!context) return null
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: "opaque" })
    return new Renderer(device, context, format)
  } catch (e) {
    console.error("[webgpu]", e)
    return null
  }
}
