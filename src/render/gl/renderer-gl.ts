import { MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS } from "../../../shared/config"
import type { RenderBackend } from "../backend"
import type { LevelData } from "../level-mesh"
import { LIGHT_FLOATS, OCC_FLOATS } from "../lighting"
import { VERT_BYTES, type Mesh } from "../mesh"
import { type FrameInput, INST_FLOATS, SPRITE_FLOATS } from "../renderer"
import { FRAME_FLOATS } from "../shaders"
import { LAMP_TEX_W, OCC_TEX_H, OCC_TEX_W, compositeFs, downFs, fullscreenVs, polarFs, sceneFs, sceneVs, spriteFs, spriteVs, upFs } from "./shaders-gl"

const BLOOM_LEVELS = 5
const MAX_SPRITES = 8192

type Buf = { buf: WebGLBuffer; count: number }
type Chunk = { first: number; count: number; box: readonly [number, number, number, number] }
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

/**
 * The WebGL2 renderer, for browsers without WebGPU (Firefox, Mullvad with WebGL on). The same frame, in the same
 * order, as src/render/renderer.ts: a polar shadow pass (here a fragment pass into two float textures, one row per
 * light), an MSAA HDR scene pass resolved by a blit, bloom, and the graded composite. Needs EXT_color_buffer_float to
 * render to float targets; createGl() returns null without it.
 */
export class GlRenderer implements RenderBackend {
  readonly kind = "webgl"
  drawnChunks = 0
  width = 0
  height = 0
  private progs: Record<string, WebGLProgram> = {}
  private frameUbo: WebGLBuffer
  private lightUbo: WebGLBuffer
  private occTex: WebGLTexture
  private lampTex: WebGLTexture
  private polar: { a: WebGLTexture; b: WebGLTexture; fbo: WebGLFramebuffer }
  private floorTex: WebGLTexture
  private bounceTex: WebGLTexture
  private vao: WebGLVertexArrayObject
  private level: Buf | null = null
  private glass: Buf | null = null
  private chunks: Chunk[] = []
  private models: Buf[] = []
  private inst: WebGLBuffer
  private instCap = 4096
  private sprites: WebGLBuffer
  private msaa: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer } | null = null
  private hdr: Target | null = null
  private bloom: Target[] = []
  private samples: number

  static create(canvas: HTMLCanvasElement): GlRenderer | null {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "high-performance" })
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null
    try {
      return new GlRenderer(gl)
    } catch (e) {
      console.error("[webgl]", e)
      return null
    }
  }

  private constructor(private gl: WebGL2RenderingContext) {
    gl.getExtension("OES_texture_float_linear")
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number)
    this.progs.polar = this.program(fullscreenVs, polarFs, "polar")
    this.progs.level = this.program(sceneVs(false), sceneFs, "scene")
    this.progs.inst = this.program(sceneVs(true), sceneFs, "scene-inst")
    this.progs.sprite = this.program(spriteVs, spriteFs, "sprite")
    this.progs.down = this.program(fullscreenVs, downFs, "down")
    this.progs.up = this.program(fullscreenVs, upFs, "up")
    this.progs.composite = this.program(fullscreenVs, compositeFs, "composite")

    this.frameUbo = this.buffer(gl.UNIFORM_BUFFER, FRAME_FLOATS * 4)
    this.lightUbo = this.buffer(gl.UNIFORM_BUFFER, MAX_LIGHTS * LIGHT_FLOATS * 4)
    for (const name of ["polar", "level", "inst", "sprite"]) {
      const p = this.progs[name]!
      const fi = gl.getUniformBlockIndex(p, "FrameU")
      if (fi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, fi, 0)
      const li = gl.getUniformBlockIndex(p, "LightsU")
      if (li !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, li, 1)
    }
    this.occTex = this.dataTex(OCC_TEX_W, OCC_TEX_H, gl.RGBA32F, gl.RGBA)
    this.lampTex = this.dataTex(LAMP_TEX_W, 1, gl.R32F, gl.RED)
    const pa = this.dataTex(POLAR_RAYS, MAX_LIGHTS, gl.RGBA32F, gl.RGBA)
    const pb = this.dataTex(POLAR_RAYS, MAX_LIGHTS, gl.RGBA32F, gl.RGBA)
    const pf = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, pf)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pa, 0)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, pb, 0)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("polar framebuffer incomplete")
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.polar = { a: pa, b: pb, fbo: pf }
    this.floorTex = this.imageTex(1, 1, gl.RG8, gl.RG, new Uint8Array(2))
    this.bounceTex = this.imageTex(1, 1, gl.RGBA8, gl.RGBA, new Uint8Array(4))
    this.vao = gl.createVertexArray()!
    this.inst = this.buffer(gl.ARRAY_BUFFER, this.instCap * INST_FLOATS * 4, gl.DYNAMIC_DRAW)
    this.sprites = this.buffer(gl.ARRAY_BUFFER, MAX_SPRITES * SPRITE_FLOATS * 4, gl.DYNAMIC_DRAW)
  }

  private program(vs: string, fs: string, label: string): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`[glsl ${label}] ${gl.getShaderInfoLog(s)}`)
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[glsl ${label}] ${gl.getProgramInfoLog(p)}`)
    return p
  }

  private buffer(target: number, size: number, usage: number = this.gl.DYNAMIC_DRAW): WebGLBuffer {
    const gl = this.gl
    const b = gl.createBuffer()!
    gl.bindBuffer(target, b)
    gl.bufferData(target, size, usage)
    return b
  }

  /** A float data texture read with texelFetch: no filtering. */
  private dataTex(w: number, h: number, internal: number, format: number): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h)
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
      [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, k!, v!)
    void format
    return t
  }

  /** An 8-bit texture sampled with linear filtering (the baked floor and bounce maps). */
  private imageTex(w: number, h: number, internal: number, format: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private upload(data: ArrayBuffer, prev: Buf | null): Buf {
    const gl = this.gl
    if (prev) gl.deleteBuffer(prev.buf)
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, Math.max(64, data.byteLength), gl.STATIC_DRAW)
    if (data.byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(data))
    return { buf, count: data.byteLength / VERT_BYTES }
  }

  setLevel(level: LevelData): void {
    const gl = this.gl
    const total = level.chunks.reduce((s, c) => s + c.data.byteLength, 0)
    const all = new Uint8Array(total)
    this.chunks = []
    let off = 0
    for (const c of level.chunks) {
      all.set(new Uint8Array(c.data), off)
      this.chunks.push({ first: off / VERT_BYTES, count: c.data.byteLength / VERT_BYTES, box: c.box })
      off += c.data.byteLength
    }
    this.level = this.upload(all.buffer, this.level)
    this.glass = this.upload(level.glass, this.glass)
    gl.deleteTexture(this.floorTex)
    gl.deleteTexture(this.bounceTex)
    const f = level.floor
    this.floorTex = this.imageTex(f.w, f.h, gl.RG8, gl.RG, new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength))
    const b = level.bounce
    this.bounceTex = this.imageTex(b.w, b.h, gl.RGBA8, gl.RGBA, new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength))
  }

  addModel(mesh: Mesh): number {
    this.models.push(this.upload(mesh.pack(), null))
    return this.models.length - 1
  }

  private target(w: number, h: number): Target {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fbo, w, h }
  }

  private dropTarget(t: Target | null): void {
    if (!t) return
    this.gl.deleteTexture(t.tex)
    this.gl.deleteFramebuffer(t.fbo)
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    const gl = this.gl
    this.width = w
    this.height = h
    if (this.msaa) {
      gl.deleteFramebuffer(this.msaa.fbo)
      gl.deleteRenderbuffer(this.msaa.color)
      gl.deleteRenderbuffer(this.msaa.depth)
    }
    this.dropTarget(this.hdr)
    for (const b of this.bloom) this.dropTarget(b)
    const color = gl.createRenderbuffer()!
    gl.bindRenderbuffer(gl.RENDERBUFFER, color)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA16F, w, h)
    const depth = gl.createRenderbuffer()!
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.msaa = { fbo, color, depth }
    this.hdr = this.target(w, h)
    this.bloom = []
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const s = 2 ** (i + 1)
      this.bloom.push(this.target(Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s))))
    }
  }

  /** Points attribute `loc` at a vec4 in an interleaved buffer, per instance. */
  private instAttr(loc: number, stride: number, offset: number): void {
    const gl = this.gl
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, offset)
    gl.vertexAttribDivisor(loc, 1)
  }

  /** The level/model vertex layout: position, normal (snorm8), colour (unorm8), material and aux (half floats). */
  private meshAttrs(buf: WebGLBuffer): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERT_BYTES, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.BYTE, true, VERT_BYTES, 12)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, VERT_BYTES, 16)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 2, gl.HALF_FLOAT, false, VERT_BYTES, 20)
    for (const l of [0, 1, 2, 3]) gl.vertexAttribDivisor(l, 0)
  }

  private bindTex(prog: WebGLProgram, name: string, unit: number, tex: WebGLTexture): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(gl.getUniformLocation(prog, name), unit)
  }

  render(f: FrameInput): void {
    const gl = this.gl
    if (!this.msaa || !this.hdr) return
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUbo)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f.frame)
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.lightUbo)
    if (f.lightCount) gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f.lights, 0, Math.min(f.lightCount, MAX_LIGHTS) * LIGHT_FLOATS)
    const occTexels = Math.min(f.occluderCount, MAX_OCCLUDERS) * (OCC_FLOATS / 4)
    if (occTexels) {
      const rows = Math.ceil(occTexels / OCC_TEX_W)
      gl.bindTexture(gl.TEXTURE_2D, this.occTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, OCC_TEX_W, rows, gl.RGBA, gl.FLOAT, f.occluders.subarray(0, rows * OCC_TEX_W * 4))
    }
    if (f.lampCount) {
      gl.bindTexture(gl.TEXTURE_2D, this.lampTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(f.lampCount, MAX_MAP_LIGHTS), 1, gl.RED, gl.FLOAT, f.lampPower.subarray(0, Math.min(f.lampCount, MAX_MAP_LIGHTS)))
    }
    gl.bindVertexArray(this.vao)
    gl.disable(gl.CULL_FACE)

    // (1) Polar shadow map: a row of rays for each light.
    const nl = Math.min(f.lightCount, MAX_LIGHTS)
    if (nl) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.polar.fbo)
      gl.viewport(0, 0, POLAR_RAYS, nl)
      gl.disable(gl.DEPTH_TEST)
      gl.disable(gl.BLEND)
      const p = this.progs.polar!
      gl.useProgram(p)
      this.bindTex(p, "occTex", 0, this.occTex)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    // (2) The scene into the MSAA HDR target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaa.fbo)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0.004, 0.006, 0.014, 1)
    gl.clearDepth(1)
    gl.depthMask(true)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    const sceneTex = (p: WebGLProgram) => {
      this.bindTex(p, "polarA", 0, this.polar.a)
      this.bindTex(p, "polarB", 1, this.polar.b)
      this.bindTex(p, "lampTex", 2, this.lampTex)
      this.bindTex(p, "floorTex", 3, this.floorTex)
      this.bindTex(p, "bounceTex", 4, this.bounceTex)
    }
    const premul = () => {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.depthMask(false)
    }
    const opaque = () => {
      gl.disable(gl.BLEND)
      gl.depthMask(true)
    }
    for (const l of [5, 6, 7]) gl.disableVertexAttribArray(l)
    const lp = this.progs.level!
    gl.useProgram(lp)
    sceneTex(lp)
    opaque()
    if (this.level?.count) {
      this.meshAttrs(this.level.buf)
      const [vx0, vy0, vx1, vy1] = f.view
      let drawn = 0
      for (const c of this.chunks) {
        if (c.box[0] > vx1 || c.box[2] < vx0 || c.box[1] > vy1 || c.box[3] < vy0) continue
        gl.drawArrays(gl.TRIANGLES, c.first, c.count)
        drawn++
      }
      this.drawnChunks = drawn
    }

    // Instances: one buffer, each batch drawn from its offset (WebGL2 has no base instance).
    const total = f.batches.reduce((s, b) => s + b.count, 0)
    if (total > this.instCap) {
      gl.deleteBuffer(this.inst)
      this.instCap = Math.ceil(total * 1.5)
      this.inst = this.buffer(gl.ARRAY_BUFFER, this.instCap * INST_FLOATS * 4)
    }
    const ranges: { model: number; first: number; count: number; alpha: boolean }[] = []
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst)
    let off = 0
    for (const b of f.batches) {
      if (!b.count) continue
      gl.bufferSubData(gl.ARRAY_BUFFER, off * INST_FLOATS * 4, b.data, 0, b.count * INST_FLOATS)
      ranges.push({ model: b.model, first: off, count: b.count, alpha: !!b.alpha })
      off += b.count
    }
    const ip = this.progs.inst!
    for (const alpha of [false, true]) {
      gl.useProgram(ip)
      sceneTex(ip)
      if (alpha) premul()
      else opaque()
      for (const r of ranges) {
        if (r.alpha !== alpha) continue
        const m = this.models[r.model]!
        this.meshAttrs(m.buf)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst)
        const base = r.first * INST_FLOATS * 4
        this.instAttr(5, INST_FLOATS * 4, base)
        this.instAttr(6, INST_FLOATS * 4, base + 16)
        this.instAttr(7, INST_FLOATS * 4, base + 32)
        gl.drawArraysInstanced(gl.TRIANGLES, 0, m.count, r.count)
      }
      for (const l of [5, 6, 7]) {
        gl.vertexAttribDivisor(l, 0)
        gl.disableVertexAttribArray(l)
      }
      if (!alpha && this.glass?.count) {
        gl.useProgram(lp)
        premul()
        this.meshAttrs(this.glass.buf)
        gl.drawArrays(gl.TRIANGLES, 0, this.glass.count)
      }
    }

    // Sprites: premultiplied, then additive.
    for (const l of [0, 1, 2, 3]) gl.disableVertexAttribArray(l)
    const sp = this.progs.sprite!
    gl.useProgram(sp)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sprites)
    const half = MAX_SPRITES / 2
    for (const [data, count, additive] of [
      [f.alphaSprites, Math.min(f.alphaCount, half), false],
      [f.addSprites, Math.min(f.addCount, half), true],
    ] as const) {
      if (!count) continue
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * SPRITE_FLOATS)
      this.instAttr(0, SPRITE_FLOATS * 4, 0)
      this.instAttr(1, SPRITE_FLOATS * 4, 16)
      this.instAttr(2, SPRITE_FLOATS * 4, 32)
      gl.enable(gl.BLEND)
      gl.depthMask(false)
      if (additive) gl.blendFunc(gl.ONE, gl.ONE)
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count)
    }
    for (const l of [0, 1, 2]) {
      gl.vertexAttribDivisor(l, 0)
      gl.disableVertexAttribArray(l)
    }
    gl.depthMask(true)
    gl.disable(gl.DEPTH_TEST)

    // Resolve the MSAA target into the HDR texture.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaa.fbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.hdr.fbo)
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)

    // (3) Bloom down, then up (additive onto the level above), then the composite to the canvas.
    const post = (prog: WebGLProgram, dst: Target | null, src: Target, P: [number, number, number, number], extra?: Target) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst?.fbo ?? null)
      gl.viewport(0, 0, dst?.w ?? this.width, dst?.h ?? this.height)
      gl.useProgram(prog)
      this.bindTex(prog, "src", 0, src.tex)
      if (extra) this.bindTex(prog, "bloomTex", 1, extra.tex)
      gl.uniform4f(gl.getUniformLocation(prog, "P"), ...P)
      gl.uniform4f(gl.getUniformLocation(prog, "G"), ...f.grade)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.disable(gl.BLEND)
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? this.hdr : this.bloom[i - 1]!
      post(this.progs.down!, this.bloom[i]!, src, [1 / src.w, 1 / src.h, i === 0 ? 1 : 0, 0])
    }
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const src = this.bloom[i]!
      post(this.progs.up!, this.bloom[i - 1]!, src, [1 / src.w, 1 / src.h, 0, 0])
    }
    gl.disable(gl.BLEND)
    post(this.progs.composite!, null, this.hdr, [1 / this.hdr.w, 1 / this.hdr.h, 0, 0], this.bloom[0])
    gl.bindVertexArray(null)
  }
}
