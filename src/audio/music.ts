/**
 * Tension music for the zombie modes, synthesised like the rest of the sound: a low drone a semitone apart under a
 * slowly breathing filter, a heartbeat that quickens with the threat, a string section that swells and climbs
 * through each wave and resolves when it's cleared, a ticking clock as it gets close, and a sting when a wave starts.
 * `update` sets how loud (on/off), how tense (0..1) and how far through the wave; every layer eases toward it.
 */
/** The string chord over its root: minor triad, then the flat-ninth that comes in with the threat. */
const STRING_CHORD = [0, 3, 7, 13] as const
/** Where the root climbs through a wave: A, B, C. */
const RISE = [0, 2, 3] as const

export class Music {
  private on = 0
  private tense = 0
  private nextBeat = 0
  private nextTick = 0
  private noise: AudioBuffer
  private out: GainNode
  private drone: GainNode
  private droneLp: BiquadFilterNode
  private strings: GainNode
  private stringLp: BiquadFilterNode
  private tremDepth: GainNode
  private tremRate: OscillatorNode
  /** The chord's voices (two detuned saws each) and the dissonant voice on top, which comes in with the threat. */
  private voices: { saws: OscillatorNode[]; gain: GainNode }[] = []
  private root = 0
  /** While the cleared-wave chord rings out, the swell leaves the strings alone until then. */
  private resolvingUntil = 0
  private beat: GainNode
  private nodes: AudioScheduledSourceNode[] = []

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
  ) {
    const len = ctx.sampleRate
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    this.out = this.gain(0, dest)

    // Drone: A1 and B-flat1 rubbing against each other, a sub an octave down, under a lowpass that breathes.
    this.droneLp = ctx.createBiquadFilter()
    this.droneLp.type = "lowpass"
    this.droneLp.frequency.value = 220
    this.droneLp.Q.value = 4
    this.drone = this.gain(0, this.out)
    this.droneLp.connect(this.drone)
    for (const [f, type, g] of [
      [55, "sawtooth", 0.22],
      [58.27, "sawtooth", 0.18],
      [27.5, "sine", 0.5],
    ] as const)
      this.osc(f, type, this.gain(g, this.droneLp))
    this.lfoTo(0.07, 120, this.droneLp.frequency)

    // Strings: a minor chord on A3 (two detuned saws a voice, for an ensemble), a flat-ninth on top for dread, all
    // through a lowpass that opens as they swell, with a tremolo that deepens and quickens.
    this.strings = this.gain(0, this.out)
    this.stringLp = ctx.createBiquadFilter()
    this.stringLp.type = "lowpass"
    this.stringLp.frequency.value = 700
    this.stringLp.Q.value = 0.7
    const trem = this.gain(0.75, this.strings)
    this.stringLp.connect(trem)
    this.tremDepth = this.gain(0.1, null)
    this.tremDepth.connect(trem.gain)
    this.tremRate = this.osc(4, "sine", this.tremDepth)
    for (const [i, g] of [0.07, 0.05, 0.05, 0].entries()) {
      const gain = this.gain(g, this.stringLp)
      const saws = [-7, 7].map((cents) => this.osc(220 * 2 ** (STRING_CHORD[i]! / 12), "sawtooth", gain, cents + (Math.random() - 0.5) * 4))
      this.voices.push({ saws, gain })
    }

    this.beat = this.gain(0.9, this.out)
  }

  private gain(v: number, to: AudioNode | null): GainNode {
    const g = this.ctx.createGain()
    g.gain.value = v
    if (to) g.connect(to)
    return g
  }

  private osc(f: number, type: OscillatorType, to: AudioNode, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.value = f
    o.detune.value = detune
    o.connect(to)
    o.start()
    this.nodes.push(o)
    return o
  }

  /** A sine LFO at `rate` Hz swinging `param` by ±`depth`. */
  private lfoTo(rate: number, depth: number, param: AudioParam): void {
    const g = this.gain(depth, null)
    g.connect(param)
    this.osc(rate, "sine", g)
  }

  /**
   * `on` fades the whole thing in or out; `tension` (0..1) picks the layers and the heartbeat's pace; `wave` is how
   * far through the current wave (0..1), or null between waves, when the strings rest.
   */
  update(on: boolean, tension: number, wave: number | null = null): void {
    const t = this.ctx.currentTime
    const target = on ? 1 : 0
    this.on += (target - this.on) * 0.02
    this.tense += (Math.max(0, Math.min(1, tension)) - this.tense) * 0.01
    const k = this.tense
    this.out.gain.setTargetAtTime(0.55 * this.on, t, 0.4)
    this.drone.gain.setTargetAtTime(0.35 + 0.35 * k, t, 0.8)
    this.droneLp.Q.setTargetAtTime(4 + 6 * k, t, 1)
    if (t >= this.resolvingUntil) this.swell(t, wave, k)
    if (this.on < 0.02) {
      this.nextBeat = t
      this.nextTick = t
      return
    }
    // Heartbeat: lub-dub, 54 bpm when it's quiet up to 128 when they're on you.
    const period = 60 / (54 + 74 * k)
    if (this.nextBeat < t) this.nextBeat = t + 0.05
    while (this.nextBeat < t + 0.25) {
      this.thump(this.nextBeat, 0.55 + 0.4 * k)
      this.thump(this.nextBeat + Math.min(0.24, period * 0.32), 0.3 + 0.25 * k)
      this.nextBeat += period
    }
    // A ticking clock once it's tense: on eighth notes of the heartbeat.
    if (this.nextTick < t) this.nextTick = t + 0.05
    while (this.nextTick < t + 0.25) {
      if (k > 0.55) this.tick(this.nextTick, (k - 0.55) * 0.5)
      this.nextTick += period / 2
    }
  }

  /**
   * The rising swell, kept in the background: the chord's root climbs A, B, C as the wave goes on, gliding slowly up a
   * step at a time and getting a little louder; a faint flat-ninth comes in with the threat.
   */
  private swell(t: number, wave: number | null, k: number): void {
    if (wave === null) {
      this.strings.gain.setTargetAtTime(0, t, 1.2)
      this.setRoot(t, 0, 2)
      return
    }
    const u = Math.max(0, Math.min(1, wave))
    this.setRoot(t, RISE[Math.min(RISE.length - 1, Math.floor(u * RISE.length))]!, 3)
    this.strings.gain.setTargetAtTime(0.08 + 0.2 * u + 0.08 * Math.max(0, k - 0.4), t, 2.5)
    this.stringLp.frequency.setTargetAtTime(750 + 500 * u, t, 2.5)
    this.tremDepth.gain.setTargetAtTime(0.05 + 0.1 * u, t, 2)
    this.tremRate.frequency.setTargetAtTime(4 + 1.5 * u, t, 2)
    this.voices[3]!.gain.gain.setTargetAtTime(Math.max(0, k - 0.5) * 0.03, t, 2)
  }

  /** Moves the chord to sit on `semis` above A3, gliding there with time constant `glide`. */
  private setRoot(t: number, semis: number, glide: number, chord: readonly number[] = STRING_CHORD): void {
    this.root = semis
    for (const [i, v] of this.voices.entries()) for (const o of v.saws) o.frequency.setTargetAtTime(220 * 2 ** ((semis + chord[i]!) / 12), t, glide)
  }

  /** A wave is cleared: the strings turn major on the note they reached and fade away. */
  resolve(): void {
    if (this.on < 0.05) return
    const t = this.ctx.currentTime
    this.resolvingUntil = t + 4
    this.setRoot(t, this.root, 0.6, [0, 4, 7, 12])
    this.voices[3]!.gain.gain.setTargetAtTime(0, t, 0.3)
    this.tremDepth.gain.setTargetAtTime(0.03, t, 0.5)
    this.strings.gain.setTargetAtTime(0, t + 0.6, 1)
  }

  private thump(at: number, g: number): void {
    const o = this.ctx.createOscillator()
    o.type = "sine"
    o.frequency.setValueAtTime(72, at)
    o.frequency.exponentialRampToValueAtTime(38, at + 0.16)
    const e = this.gain(0, this.beat)
    e.gain.setValueAtTime(0, at)
    e.gain.linearRampToValueAtTime(g, at + 0.008)
    e.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
    o.connect(e)
    o.start(at)
    o.stop(at + 0.25)
  }

  private tick(at: number, g: number): void {
    const s = this.ctx.createBufferSource()
    s.buffer = this.noise
    const hp = this.ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 6000
    const e = this.gain(0, this.out)
    e.gain.setValueAtTime(g, at)
    e.gain.exponentialRampToValueAtTime(0.0001, at + 0.03)
    s.connect(hp).connect(e)
    s.start(at, Math.random() * 0.5)
    s.stop(at + 0.04)
  }

  /** A wave starts: a deep boom, a swelling hiss and a dissonant stab sliding up. */
  sting(): void {
    if (this.on < 0.05) return
    const t = this.ctx.currentTime + 0.02
    this.thump(t, 1.2)
    const s = this.ctx.createBufferSource()
    s.buffer = this.noise
    const bp = this.ctx.createBiquadFilter()
    bp.type = "bandpass"
    bp.Q.value = 2
    bp.frequency.setValueAtTime(300, t)
    bp.frequency.exponentialRampToValueAtTime(3200, t + 1.6)
    const e = this.gain(0, this.out)
    e.gain.setValueAtTime(0, t)
    e.gain.linearRampToValueAtTime(0.35, t + 1.4)
    e.gain.exponentialRampToValueAtTime(0.0001, t + 1.9)
    s.connect(bp).connect(e)
    s.start(t)
    s.stop(t + 2)
    for (const f of [220, 233.08, 311.13]) {
      const o = this.ctx.createOscillator()
      o.type = "sawtooth"
      o.frequency.setValueAtTime(f, t)
      o.frequency.exponentialRampToValueAtTime(f * 1.06, t + 1.2)
      const g = this.gain(0, this.out)
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.06, t + 0.05)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3)
      o.connect(g)
      o.start(t)
      o.stop(t + 1.35)
    }
  }
}
