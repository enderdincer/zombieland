import { MAT, type Mat, Mesh, type Rgb } from "./mesh"
import { hex } from "./models"

/**
 * The dead of the office tower: the night shift that didn't make it out, in torn shirts and loose ties, grey-green
 * skin, slack open jaws and sunken glowing eyes, clawed hands. The brute is a hulking shirtless one with a stretched
 * gut and stitched scars. Parts use the soldier's bones and joints (src/render/person.ts RIG): every part faces +x
 * with +y up and +z to its right, pivot at its joint, so the same animation and ragdolls drive them. Accents (the eyes
 * and the glow in the wounds) take the zombie's kind colour.
 */

const SKIN = hex(0x5c8248)
const SKIN_D = hex(0x41603a)
const SKIN_B = hex(0x4f5a3e)
const SHIRT = hex(0x6c6852)
const SHIRT_D = hex(0x4e4a3c)
const GRIME = hex(0x4a3e2a)
const TIE = hex(0x6e1616)
const SLACKS = hex(0x34353c)
const SLACKS_D = hex(0x28292e)
const BELT = hex(0x1c1a18)
const SHOE = hex(0x221c18)
const BLOOD = hex(0x4a0c08)
const GORE = hex(0x6a1a12)
const BONE = hex(0xb8b09a)
const HAIR = hex(0x1f1c19)
const MOUTH = hex(0x120606)
const ACC: Rgb = [1, 1, 1]

/** Zombie meshes default to the actor material, like the soldier's. */
class Flesh extends Mesh {
  override box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.actor, aux = 0, top?: Rgb, bottom = false): void {
    super.box(x0, y0, z0, x1, y1, z1, col, mat === MAT.lit ? MAT.actor : mat, aux, top, bottom)
  }
  override prism(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.actor, aux = 0, cap = true): void {
    super.prism(cx, cz, r0, r1, y0, y1, sides, col, mat === MAT.lit ? MAT.actor : mat, aux, cap)
  }
}

const acc = (m: Mesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => m.box(x0, y0, z0, x1, y1, z1, ACC, MAT.accent)

/** Widths for the walker and the brute: torso (front-back, side-side), arms and legs. */
type Build = { brute: boolean; boss?: boolean; tx: number; tz: number; arm: number; leg: number }
const WALKER: Build = { brute: false, tx: 1, tz: 1, arm: 1, leg: 1 }
const BRUTE: Build = { brute: true, tx: 1.45, tz: 1.35, arm: 1.6, leg: 1.35 }
/** The boss: a brute grown huge, bone breaking through its back and glowing cracks across its hide. */
const BOSS: Build = { brute: true, boss: true, tx: 1.75, tz: 1.65, arm: 2, leg: 1.6 }

function pelvis(b: Build): Mesh {
  const m = new Flesh()
  const x = b.tx
  const z = b.tz
  m.box(-0.12 * x, -0.07, -0.18 * z, 0.12 * x, 0.1, 0.18 * z, b.brute ? SLACKS_D : SLACKS)
  m.box(-0.13 * x, 0.06, -0.19 * z, 0.13 * x, 0.11, 0.19 * z, BELT)
  // A shirt tail hanging out the back, and a dark stain down the front.
  if (!b.brute) m.box(-0.135, -0.06, -0.1, -0.12, 0.07, 0.06, SHIRT_D)
  m.box(0.121 * x, -0.06, -0.05, 0.125 * x, 0.06, 0.07, BLOOD)
  return m
}

function torso(b: Build): Mesh {
  const m = new Flesh()
  if (b.brute) {
    // Bare: a broad chest over a sagging gut, stitched scars, a gash glowing in the side.
    m.box(-0.16, -0.02, -0.21, 0.2, 0.22, 0.21, SKIN_D)
    m.box(-0.2, 0.15, -0.3, 0.2, 0.5, 0.3, SKIN)
    m.box(0.17, 0.0, -0.17, 0.26, 0.2, 0.17, SKIN_D)
    m.box(-0.16, 0.44, -0.22, 0.12, 0.56, 0.22, SKIN_D)
    for (const y of [0.22, 0.29, 0.36]) m.box(0.2, y, -0.12, 0.205, y + 0.02, 0.06, BONE)
    m.box(0.2, 0.18, -0.15, 0.206, 0.42, -0.13, GORE)
    m.box(-0.205, 0.2, 0.05, -0.2, 0.45, 0.2, BLOOD)
    acc(m, 0.0, 0.25, 0.3, 0.1, 0.29, 0.302)
    // Shoulder hump, scarred and bloodied on top, with a stitched seam.
    m.box(-0.2, 0.46, -0.18, 0.0, 0.56, 0.18, SKIN)
    m.box(-0.12, 0.56, -0.12, -0.02, 0.565, 0.02, BLOOD)
    for (const z of [-0.2, -0.12, -0.04, 0.04, 0.12, 0.2]) m.box(-0.06, 0.5, z - 0.008, 0.02, 0.505, z + 0.008, BONE)
    m.box(-0.2, 0.3, 0.12, -0.15, 0.5, 0.28, GRIME)
    if (b.boss) {
      // Bone spines up the back and across the shoulders, and the glow seeping through cracks in the hide.
      for (const [x, z, h] of [
        [-0.17, -0.2, 0.16],
        [-0.15, 0, 0.22],
        [-0.17, 0.2, 0.16],
        [-0.06, -0.28, 0.12],
        [-0.06, 0.28, 0.12],
      ] as const)
        m.box(x - 0.025, 0.55, z - 0.025, x + 0.025, 0.55 + h, z + 0.025, BONE)
      acc(m, 0.2, 0.12, -0.2, 0.206, 0.14, 0.1)
      acc(m, 0.2, 0.32, -0.05, 0.206, 0.46, -0.03)
      acc(m, -0.205, 0.18, -0.25, -0.2, 0.2, 0.0)
      acc(m, -0.1, 0.565, -0.15, 0.05, 0.57, -0.13)
    }
    return m
  }
  // Abdomen, then the chest in a torn shirt, skin and ribs showing through the rips.
  m.box(-0.11, -0.02, -0.15, 0.11, 0.2, 0.15, SHIRT_D)
  m.box(-0.13, 0.15, -0.2, 0.13, 0.45, 0.2, SHIRT)
  m.box(0.13, 0.14, -0.16, 0.135, 0.3, 0.01, SKIN_D)
  for (const y of [0.17, 0.21, 0.25]) m.box(0.135, y, -0.14, 0.14, y + 0.018, -0.02, BONE)
  m.box(0.131, 0.28, 0.06, 0.137, 0.4, 0.17, BLOOD)
  m.box(-0.137, 0.2, -0.18, -0.131, 0.38, -0.02, BLOOD)
  // A gash glowing faintly where the bite went in.
  acc(m, 0.137, 0.33, -0.12, 0.142, 0.35, -0.04)
  // Collar torn open, and the tie hanging loose and askew.
  m.box(0.02, 0.43, -0.12, 0.12, 0.49, 0.12, SHIRT_D)
  m.box(0.135, 0.18, 0.02, 0.15, 0.44, 0.06, TIE)
  m.box(0.135, 0.13, 0.03, 0.15, 0.19, 0.08, TIE)
  // Hunched shoulders, soaked and filthy across the top where the camera sees them.
  m.box(-0.12, 0.42, -0.21, 0.08, 0.48, 0.21, SHIRT)
  m.box(-0.05, 0.48, -0.2, 0.07, 0.485, -0.06, BLOOD)
  m.box(-0.12, 0.48, 0.04, -0.02, 0.485, 0.19, GRIME)
  m.box(-0.135, 0.26, -0.12, -0.13, 0.42, 0.1, GRIME)
  m.box(-0.12, 0.45, -0.04, 0.0, 0.452, 0.05, GORE)
  return m
}

function head(b: Build): Mesh {
  const m = new Flesh()
  const s = b.boss ? 1.3 : b.brute ? 1.15 : 1
  m.box(-0.05 * s, -0.02, -0.05 * s, 0.05 * s, 0.08, 0.05 * s, SKIN_D)
  // Skull, a slack jaw hanging open over a dark mouth with a few teeth.
  m.box(-0.09 * s, 0.07, -0.085 * s, 0.09 * s, 0.25 * s, 0.085 * s, SKIN)
  m.box(-0.075 * s, 0.24 * s, -0.07 * s, 0.075 * s, 0.27 * s, 0.07 * s, SKIN_D)
  m.box(0.0, 0.01, -0.07 * s, 0.1 * s, 0.07, 0.07 * s, SKIN_D)
  m.box(0.07 * s, 0.035, -0.05 * s, 0.096 * s, 0.1, 0.05 * s, MOUTH)
  for (const z of [-0.03, 0, 0.03]) m.box(0.09 * s, 0.085, z * s - 0.008, 0.1 * s, 0.1, z * s + 0.008, BONE)
  // Sunken sockets with the glow in them, a heavy brow, a torn ear and a scalp wound.
  m.box(0.088 * s, 0.13 * s, -0.07 * s, 0.093 * s, 0.18 * s, -0.015 * s, MOUTH)
  m.box(0.088 * s, 0.13 * s, 0.015 * s, 0.093 * s, 0.18 * s, 0.07 * s, MOUTH)
  acc(m, 0.092 * s, 0.145 * s, -0.055 * s, 0.096 * s, 0.165 * s, -0.03 * s)
  acc(m, 0.092 * s, 0.145 * s, 0.03 * s, 0.096 * s, 0.165 * s, 0.055 * s)
  m.box(0.075 * s, 0.18 * s, -0.08 * s, 0.1 * s, 0.205 * s, 0.08 * s, SKIN_D)
  m.box(-0.03, 0.11, 0.085 * s, 0.03, 0.17, 0.1 * s, SKIN_D)
  if (b.brute) {
    // A lumpy bald skull: a ridge of scar tissue, a bulging brow, mottled patches on top.
    m.box(-0.06, 0.27 * s, -0.025, 0.06, 0.295 * s, 0.025, SKIN_D)
    m.box(-0.08, 0.255 * s, 0.03, -0.01, 0.275 * s, 0.08, SKIN_B)
    m.box(0.07 * s, 0.19 * s, -0.09 * s, 0.11 * s, 0.22 * s, 0.09 * s, SKIN_D)
  } else m.box(-0.02, 0.27 * s, -0.04, 0.05, 0.275 * s, 0.03, GORE)
  if (!b.brute) {
    // Lank hair in clumps, a bald patch where it came out.
    m.box(-0.1, 0.18, -0.088, 0.02, 0.27, -0.03, HAIR)
    m.box(-0.1, 0.18, 0.04, -0.02, 0.27, 0.088, HAIR)
    m.box(-0.1, 0.07, -0.06, -0.09, 0.2, 0.06, HAIR)
  }
  return m
}

function upperArm(b: Build): Mesh {
  const m = new Flesh()
  const w = 0.07 * b.arm
  if (b.brute) {
    m.box(-w - 0.01, -0.12, -w - 0.01, w + 0.01, 0.06, w + 0.01, SKIN)
    m.box(-w, -0.3, -w, w, -0.1, w, SKIN_D)
    m.box(w, -0.2, -0.02, w + 0.004, -0.12, 0.03, GORE)
    return m
  }
  // A shirt sleeve ripped off above the elbow, skin below it.
  m.box(-0.075, -0.15, -0.075, 0.075, 0.05, 0.075, SHIRT)
  m.box(-0.08, -0.17, -0.08, 0.08, -0.14, 0.08, SHIRT_D)
  m.box(-0.055, -0.29, -0.055, 0.055, -0.15, 0.055, SKIN)
  m.box(0.055, -0.25, -0.02, 0.06, -0.19, 0.03, BLOOD)
  return m
}

function foreArm(b: Build): Mesh {
  const m = new Flesh()
  const w = 0.05 * b.arm
  m.box(-w, -0.22, -w, w, 0.03, w, b.brute ? SKIN_D : SKIN_B)
  // Bone showing through a bite.
  m.box(w, -0.16, -0.015, w + 0.012, -0.07, 0.015, BONE)
  m.box(w - 0.004, -0.18, -0.03, w + 0.006, -0.05, 0.03, GORE)
  // A clawed hand: palm, then crooked fingers reaching on.
  const h = b.brute ? 1.35 : 1
  m.box(-0.045 * h, -0.3 * h, -0.045 * h, 0.05 * h, -0.21, 0.045 * h, SKIN_D)
  for (const z of [-0.03, -0.01, 0.01, 0.03]) m.box(0.0, -0.37 * h, z * h - 0.009, 0.03 * h, -0.29 * h, z * h + 0.009, SKIN_B)
  for (const z of [-0.03, -0.01, 0.01, 0.03]) m.box(0.02 * h, -0.39 * h, z * h - 0.007, 0.05 * h, -0.35 * h, z * h + 0.007, BONE)
  return m
}

function thigh(b: Build): Mesh {
  const m = new Flesh()
  const w = 0.085 * b.leg
  m.box(-w, -0.43, -w * 0.95, w, 0.04, w * 0.95, b.brute ? SLACKS_D : SLACKS)
  m.box(w - 0.004, -0.34, -0.04, w + 0.003, -0.22, 0.05, BLOOD)
  return m
}

function shin(b: Build): Mesh {
  const m = new Flesh()
  const w = 0.065 * b.leg
  // Trouser leg torn away below the knee, the shin bare and filthy.
  m.box(-w - 0.005, -0.14, -w - 0.005, w + 0.005, 0.02, w + 0.005, b.brute ? SLACKS_D : SLACKS)
  m.box(-w, -0.32, -w, w, -0.13, w, SKIN_B)
  m.box(w - 0.004, -0.27, -0.025, w + 0.004, -0.17, 0.02, GORE)
  m.box(-w - 0.005, -0.42, -w - 0.005, w + 0.01, -0.31, w + 0.005, SKIN_D)
  return m
}

function foot(b: Build): Mesh {
  const m = new Flesh()
  const w = 0.06 * b.leg
  // One office shoe left, split along the side; bare toes poke out of it.
  m.box(-0.075, -0.07, -w, 0.15, 0.015, w, SHOE)
  m.box(-0.078, -0.085, -w - 0.003, 0.16, -0.068, w + 0.003, BELT)
  m.box(0.15, -0.07, -w * 0.8, 0.19, -0.02, w * 0.8, SKIN_B)
  return m
}

export type ZombieParts = { pelvis: Mesh; torso: Mesh; head: Mesh; upperArm: Mesh; foreArm: Mesh; thigh: Mesh; shin: Mesh; foot: Mesh }

/** The body parts of a walker (also the runner's and sprinter's), a brute or the boss. Guns and the rest are the soldier's. */
export function zombieModels(kind: "walker" | "brute" | "boss" = "walker"): ZombieParts {
  const b = kind === "boss" ? BOSS : kind === "brute" ? BRUTE : WALKER
  return { pelvis: pelvis(b), torso: torso(b), head: head(b), upperArm: upperArm(b), foreArm: foreArm(b), thigh: thigh(b), shin: shin(b), foot: foot(b) }
}
