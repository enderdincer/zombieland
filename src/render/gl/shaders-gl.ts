import { MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS } from "../../../shared/config"

/**
 * GLSL ES 3.00 ports of src/render/shaders.ts for the WebGL2 renderer, line for line where the languages allow.
 * What differs: the frame and the lights are uniform blocks; the polar shadow map, the occluders and the lamp powers
 * are float textures (WebGL2 has no storage buffers), and the polar map is filled by a fragment pass instead of a
 * compute pass. Fragment y runs bottom-up in GL, and render-target textures aren't flipped.
 */

/** The occluder texture is this wide; each occluder takes two texels. */
export const OCC_TEX_W = 2048
export const OCC_TEX_H = Math.ceil((MAX_OCCLUDERS * 2) / OCC_TEX_W)
export const LAMP_TEX_W = MAX_MAP_LIGHTS

const head = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`

const common = /* glsl */ `
#define MAX_LIGHTS ${MAX_LIGHTS}
#define RAYS ${POLAR_RAYS}
const float TAU = 6.2831853;
const float PI = 3.1415927;
const float GAIN = 5.0;
const float FAR = 1e9;

layout(std140) uniform FrameU {
  mat4 viewProj;
  vec4 cam;
  vec4 screen;
  vec4 eye;
  vec4 ambient;
  vec4 focus;
  vec4 gradeU;
  vec4 mapU;
} F;

// Lights: pos (plan x, height, plan y, radius), color (rgb, power), cone (dir x, dir y, cos half, has cone),
// extra (first occluder, occluder count, fixture size, map light id).
layout(std140) uniform LightsU {
  vec4 LT[${MAX_LIGHTS * 4}];
};

float hash2(vec2 p) {
  vec2 q = fract(p * vec2(0.1031, 0.1030));
  vec2 r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  return noise2(p) * 0.5 + noise2(p * 2.03 + 7.1) * 0.3 + noise2(p * 4.1 + 3.7) * 0.2;
}
`

/** A full-screen triangle; the polar pass and the post passes share it. */
export const fullscreenVs = /* glsl */ `${head}
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vUv = p;
}
`

/** The polar shadow map: one fragment per (ray, light slot); x is the ray, y the slot. Two targets, as the two vec4s. */
export const polarFs = /* glsl */ `${head}${common}
uniform sampler2D occTex;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;

vec4 occ(int k) { return texelFetch(occTex, ivec2(k % ${OCC_TEX_W}, k / ${OCC_TEX_W}), 0); }

bool slab(float o, float d, float lo, float hi, inout float t0, inout float t1) {
  if (abs(d) < 1e-9) { return o >= lo && o <= hi; }
  float a = (lo - o) / d;
  float b = (hi - o) / d;
  if (a > b) { float s = a; a = b; b = s; }
  t0 = max(t0, a);
  t1 = min(t1, b);
  return t0 <= t1;
}

void main() {
  int ray = int(gl_FragCoord.x);
  int slot = int(gl_FragCoord.y);
  float ang = (float(ray) + 0.5) / float(RAYS) * TAU;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec4 Lpos = LT[slot * 4];
  vec4 Lextra = LT[slot * 4 + 3];
  vec2 o = Lpos.xz;
  float hl = Lpos.y;
  float full = Lpos.w + 0.5;
  vec3 a = vec3(FAR, FAR, 0.0);
  vec3 b = vec3(FAR, FAR, 0.0);
  int first = int(Lextra.x);
  int n = min(int(Lextra.y), ${MAX_OCCLUDERS} - first);
  for (int i = 0; i < n; i++) {
    vec4 r = occ((first + i) * 2);
    vec4 m = occ((first + i) * 2 + 1);
    float t0 = 0.0;
    float t1 = full;
    bool hit = false;
    float h = m.x;
    if (m.y > 0.5) {
      vec2 oc = o - r.xy;
      float bq = dot(oc, dir);
      float c = dot(oc, oc) - r.z * r.z;
      float disc = bq * bq - c;
      if (disc > 0.0) {
        float s = sqrt(disc);
        t0 = max(-bq - s, 0.0);
        t1 = -bq + s;
        hit = t1 > 0.0 && t0 < full;
      }
      h = min(h, hl - 0.25);
    } else {
      hit = slab(o.x, dir.x, r.x, r.z, t0, t1) && slab(o.y, dir.y, r.y, r.w, t0, t1);
      t1 = max(t1, t0);
      if (hit) {
        float e0 = 0.0;
        float e1 = 1e6;
        if (slab(o.x, dir.x, r.x, r.z, e0, e1) && slab(o.y, dir.y, r.y, r.w, e0, e1)) { t1 = e1; }
      }
    }
    if (!hit) { continue; }
    if (h >= hl - 0.02) {
      full = min(full, t0);
    } else if (t0 < a.x) {
      if (b.x < FAR) { b = vec3(min(b.x, a.x), max(b.y, a.y), max(b.z, a.z)); } else { b = a; }
      a = vec3(t0, t1, h);
    } else if (t0 < b.x && b.x >= FAR) {
      b = vec3(t0, t1, h);
    } else {
      b = vec3(min(b.x, t0), max(b.y, t1), max(b.z, h));
    }
  }
  outA = vec4(full, a);
  outB = vec4(b, 0.0);
}
`

const sceneVaryings = /* glsl */ `
VARY vec3 vWorld;
VARY vec3 vNormal;
VARY vec3 vColor;
flat VARY float vMat;
flat VARY float vAux;
flat VARY vec4 vExtra;
`

/** Scene vertex shader: the static level (and glass), or instanced parts when INST is defined. */
export const sceneVs = (inst: boolean) => /* glsl */ `${head}${inst ? "#define INST\n" : ""}${common}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aMatAux;
#ifdef INST
layout(location = 5) in vec4 iPosYaw;
layout(location = 6) in vec4 iTint;
layout(location = 7) in vec4 iExtra;
#endif
${sceneVaryings.replace(/VARY/g, "out")}

#ifdef INST
vec3 partRotate(vec3 p) {
  float cp = cos(iExtra.x);
  float sp = sin(iExtra.x);
  vec3 q = vec3(p.x * cp - p.y * sp, p.x * sp + p.y * cp, p.z);
  float cr = cos(iExtra.y);
  float sr = sin(iExtra.y);
  q = vec3(q.x, q.y * cr - q.z * sr, q.y * sr + q.z * cr);
  float c = cos(iPosYaw.w);
  float s = sin(iPosYaw.w);
  return vec3(q.x * c - q.z * s, q.y, q.x * s + q.z * c);
}
#endif

void main() {
#ifdef INST
  vWorld = partRotate(aPos * iTint.w) + iPosYaw.xyz;
  gl_Position = F.viewProj * vec4(vWorld, 1.0);
  vNormal = partRotate(aNormal.xyz);
  bool accent = aMatAux.x > 7.5 && aMatAux.x < 8.5;
  vColor = accent ? iTint.rgb : pow(aColor.rgb, vec3(2.2));
  vMat = accent ? 3.0 : aMatAux.x;
  vAux = accent ? 0.85 : aMatAux.y;
  vExtra = iExtra;
#else
  vWorld = aPos;
  vNormal = aNormal.xyz;
  if (aMatAux.x > 12.5) {
    float ph = aNormal.z * 40.0;
    float t = F.cam.w;
    vec3 drift = vec3(sin(t * 0.21 + ph) + 0.4 * sin(t * 0.53 + ph * 1.7), 0.6 * sin(t * 0.17 + ph * 2.3), cos(t * 0.19 + ph * 0.7) + 0.4 * sin(t * 0.47 + ph)) * 0.22;
    vec3 c = aPos + drift;
    vec3 toCam = normalize(F.cam.xyz - c);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 up = cross(toCam, right);
    float size = 0.012 + 0.012 * fract(ph * 3.7);
    vWorld = c + (right * aNormal.x + up * aNormal.y) * size;
    vNormal = vec3(aNormal.xy, ph);
  }
  gl_Position = F.viewProj * vec4(vWorld, 1.0);
  vColor = pow(aColor.rgb, vec3(2.2));
  vMat = aMatAux.x;
  vAux = aMatAux.y;
  vExtra = vec4(0.0, 0.0, 1.0, 0.0);
#endif
}
`

export const sceneFs = /* glsl */ `${head}${common}
uniform sampler2D polarA;
uniform sampler2D polarB;
uniform sampler2D lampTex;
uniform sampler2D floorTex;
uniform sampler2D bounceTex;
${sceneVaryings.replace(/VARY/g, "in")}
out vec4 outColor;

bool cutaway(vec3 world) {
  if (F.eye.z < 0.5 || world.y < F.focus.z) { return false; }
  if (world.z < F.eye.y + 0.25) { return false; }
  // GL fragment y runs bottom-up, so NDC y is direct.
  vec2 ndc = vec2(gl_FragCoord.x / F.screen.x * 2.0 - 1.0, gl_FragCoord.y / F.screen.y * 2.0 - 1.0);
  vec2 dv = (ndc - F.focus.xy) * vec2(F.screen.x / F.screen.y, 1.0);
  float r = length(dv) / F.eye.w;
  if (r > 1.0) { return false; }
  ivec2 p = ivec2(gl_FragCoord.xy) % 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[p.y * 4 + p.x] + 0.5) / 16.0 < smoothstep(1.0, 0.6, r) * 0.85;
}

float partialShadow(float t0, float t1, float h, float d, float y, float hl, float size) {
  if (t0 >= FAR || y >= h - 0.03 || d <= t0) { return 1.0; }
  float lift = hl + 0.6;
  float end = min(t1 * (lift - y) / max(lift - h, 0.05), t1 + 6.0);
  float e0 = 0.015 + size * 0.04;
  float e1 = 0.03 + size * 0.5 * (end - t1) / max(t1, 0.3);
  float s = smoothstep(t0 - e0, t0 + e0, d) * (1.0 - smoothstep(end - e1, end + e1, d));
  return 1.0 - s * 0.82;
}

float tapVis(int slot, float fi, float d, float y, float hl, float size) {
  int i = (int(round(fi)) + RAYS * 4) % RAYS;
  vec4 p0 = texelFetch(polarA, ivec2(i, slot), 0);
  vec4 p1 = texelFetch(polarB, ivec2(i, slot), 0);
  float full = p0.x;
  float ef = 0.03 + size * 0.45 * max(d - full, 0.0) / max(full, 0.3);
  float v = 1.0 - smoothstep(full - 0.02, full + ef, d);
  v *= partialShadow(p0.y, p0.z, p0.w, d, y, hl, size);
  v *= partialShadow(p1.x, p1.y, p1.z, d, y, hl, size);
  return v;
}

float shadowAt(int slot, vec2 lp, float hl, float size, vec2 p, float y) {
  vec2 dv = p - lp;
  float d = length(dv);
  if (d < 0.05) { return 1.0; }
  float a = atan(dv.y, dv.x);
  if (a < 0.0) { a += TAU; }
  float f = a / TAU * float(RAYS) - 0.5;
  float stepR = max(size * 0.22 / max(d, 0.4) * float(RAYS) / TAU, 0.35);
  float acc = 0.0;
  for (int k = -2; k <= 2; k++) {
    float w = k == 0 ? 0.3 : (abs(k) == 1 ? 0.2 : 0.15);
    acc += tapVis(slot, f + float(k) * stepR, d, y, hl, size) * w;
  }
  return acc;
}

void lightSum(vec3 world, vec3 n, vec3 V, float shin, float wrap, out vec3 diff, out vec3 spec) {
  diff = vec3(0.0);
  spec = vec3(0.0);
  int count = int(F.screen.z);
  vec2 plan = world.xz + n.xz * 0.04;
  for (int i = 0; i < count; i++) {
    vec4 Lpos = LT[i * 4];
    vec4 Lcol = LT[i * 4 + 1];
    vec4 Lcone = LT[i * 4 + 2];
    vec4 Lext = LT[i * 4 + 3];
    float power = Lcol.w;
    if (power <= 0.001) { continue; }
    vec2 lp = Lpos.xz;
    float r = Lpos.w;
    vec2 dv = world.xz - lp;
    float dPlan = length(dv);
    if (dPlan >= r) { continue; }
    float hl = Lpos.y;
    vec3 l3 = vec3(lp.x, hl, lp.y) - world;
    float d3 = max(length(l3), 0.05);
    vec3 ldir = l3 / d3;
    float x = dPlan / r;
    float win = 1.0 - x * x;
    win *= win;
    float dn = max(d3, max(hl, 1.25));
    float att = power * win * (0.1 + 2.6 / (1.0 + dn * dn * 0.3));
    if (Lcone.w > 0.5 && dPlan > 0.001) {
      float c = dot(dv / dPlan, Lcone.xy);
      float t = clamp((c - Lcone.z) / 0.25, 0.0, 1.0);
      att *= t * t * (3.0 - 2.0 * t);
    }
    if (att <= 0.0005) { continue; }
    float ndl = dot(n, ldir);
    float diffuse = max((ndl + wrap) / (1.0 + wrap), 0.0);
    vec2 sp = plan;
    if (n.y > 0.5 && world.y > 0.05) { sp = world.xz - dv / max(dPlan, 1e-4) * min(0.12, dPlan); }
    float vis = shadowAt(i, lp, hl, Lext.z, sp, world.y);
    diff += Lcol.rgb * att * (diffuse * vis + 0.035);
    if (shin > 0.0) {
      vec3 h = normalize(ldir + V);
      float s = pow(max(dot(n, h), 0.0), shin) * (shin + 2.0) * 0.004;
      spec += Lcol.rgb * att * s * vis;
      if (n.y > 0.9) {
        vec3 e = F.cam.xyz;
        float k = hl / (hl + e.y);
        vec2 pm = lp + (e.xz - lp) * k;
        vec2 toEye = normalize(e.xz - pm + vec2(1e-4));
        vec2 q = world.xz - pm;
        float along = dot(q, toEye);
        float across = dot(q, vec2(-toEye.y, toEye.x));
        float sz = 0.03 + Lext.z * 0.3;
        float r2 = across * across / (sz * sz) + along * along / (sz * sz * 25.0);
        spec += Lcol.rgb * power * exp(-r2) * shin * 0.0016 * vis;
      }
    }
  }
}

vec3 spill(vec3 world) {
  vec3 acc = vec3(0.0);
  int count = int(F.screen.z);
  for (int i = 0; i < count; i++) {
    vec4 Lpos = LT[i * 4];
    vec4 Lcol = LT[i * 4 + 1];
    float d = length(world.xz - Lpos.xz);
    float r = Lpos.w * 0.7;
    if (d >= r) { continue; }
    float x = 1.0 - d / r;
    acc += Lcol.rgb * Lcol.w * x * x;
  }
  return acc;
}

vec2 floorData(vec2 p) { return textureLod(floorTex, p * F.mapU.xy, 0.0).rg; }

vec3 bounceAt(vec2 p) {
  vec4 b = textureLod(bounceTex, p * F.mapU.xy, 0.0);
  vec3 c = b.rgb / max(b.a, 0.25);
  return c * c * 2.0;
}

vec3 ambientAt(vec3 n) {
  vec3 sky = F.ambient.rgb;
  return mix(sky * 0.35, sky, n.y * 0.5 + 0.5);
}

float tileEdge(vec2 g, float w) {
  float e = min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y));
  return smoothstep(0.0, w, e);
}

vec3 floorPattern(int kind, vec2 p, vec3 base, inout vec2 gloss) {
  vec3 c = base;
  if (kind == 0) {
    vec2 cell = floor(p / 0.6);
    vec2 g = fract(p / 0.6);
    int flip = (int(cell.x) + int(cell.y)) & 1;
    float q = flip == 1 ? p.y : p.x;
    float stripes = 0.5 + 0.5 * sin(q * 70.0 + noise2(p * 3.0) * 2.0);
    c *= 0.86 + 0.1 * stripes + 0.1 * (hash2(cell) - 0.5) + 0.1 * (noise2(p * 23.0) - 0.5);
    c *= mix(0.82, 1.0, tileEdge(g, 0.02));
    gloss = vec2(0.0, 0.0);
  } else if (kind == 1) {
    vec2 cell = floor(p / 0.8);
    vec2 g = fract(p / 0.8);
    c *= 0.9 + 0.14 * (hash2(cell * 1.7) - 0.5);
    c *= 0.85 + 0.3 * fbm(p * 5.0);
    c *= 1.0 - 0.08 * smoothstep(0.55, 0.8, noise2(p * 0.7 + 4.0));
    c *= mix(0.62, 1.0, tileEdge(g, 0.012));
    gloss = vec2(70.0, 0.55);
  } else if (kind == 2) {
    float row = floor(p.y / 0.2);
    float plank = floor((p.x + hash2(vec2(row, 1.0)) * 2.0) / 1.4);
    c *= 0.78 + 0.32 * hash2(vec2(row, plank));
    c *= 0.9 + 0.2 * noise2(vec2(p.x * 1.5, p.y * 30.0) + plank);
    c *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.05, fract(p.y / 0.2)));
    c *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.01, abs(fract((p.x + hash2(vec2(row, 1.0)) * 2.0) / 1.4) - 0.0)));
    gloss = vec2(30.0, 0.3);
  } else if (kind == 3) {
    c *= 0.8 + 0.3 * fbm(p * 0.9) + 0.08 * noise2(p * 11.0);
    c *= 1.0 - 0.25 * smoothstep(0.62, 0.75, fbm(p * 0.35 + 9.0));
    float crack = abs(noise2(p * 1.2) - 0.5);
    c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.012, crack)) * step(0.5, noise2(p * 0.3));
    gloss = vec2(10.0, 0.08);
  } else if (kind == 4) {
    vec2 g = fract(p / 0.6);
    vec2 h = fract(p / 0.05);
    float hole = 1.0 - smoothstep(0.18, 0.28, length(h - 0.5));
    float inner = step(0.08, g.x) * step(g.x, 0.92) * step(0.08, g.y) * step(g.y, 0.92);
    c *= mix(1.0, 0.35, hole * inner);
    c *= mix(0.55, 1.05, tileEdge(g, 0.02));
    gloss = vec2(40.0, 0.35);
  }
  return c;
}

vec3 city(vec2 p) {
  vec2 blk = floor(p / 14.0);
  vec2 f = fract(p / 14.0);
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  float street = 1.0 - smoothstep(0.03, 0.07, edge);
  vec3 c = vec3(0.006, 0.008, 0.016) * (0.6 + 0.8 * hash2(blk)) * (1.0 - street);
  c += vec3(0.9, 0.5, 0.18) * street * 0.012;
  vec2 w = floor(p / 0.3);
  float lit = step(0.975, hash2(w + blk * 7.0)) * (1.0 - street) * step(0.08, edge);
  c += mix(vec3(1.0, 0.75, 0.4), vec3(0.55, 0.75, 1.0), hash2(w * 1.7)) * lit * 0.05;
  vec2 rc = fract(p / 14.0) - 0.5;
  c += vec3(1.0, 0.1, 0.05) * step(0.8, hash2(blk + 3.0)) * (1.0 - smoothstep(0.0, 0.012, length(rc))) * (0.5 + 0.5 * sin(F.cam.w * 2.0 + hash2(blk) * 6.0));
  return c;
}

float lampK(float aux) { return texelFetch(lampTex, ivec2(int(aux), 0), 0).r; }

void main() {
  int mat = int(round(vMat));
  if (mat == 13) {
    float r = length(vNormal.xy);
    float k = lampK(vAux);
    float tw = 0.55 + 0.45 * sin(F.cam.w * 1.3 + vNormal.z * 5.0);
    float a = (1.0 - smoothstep(0.2, 1.0, r)) * k * tw * 1.6;
    outColor = vec4(vColor * a, 0.0);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 V = normalize(F.cam.xyz - vWorld);
  vec3 col;
  float alpha = 1.0;
  if (mat == 7) {
    outColor = vec4(city(vWorld.xz), 1.0);
    return;
  }
  if ((mat == 4 || mat == 9 || mat == 2 || mat == 11) && cutaway(vWorld)) { discard; }
  if (mat == 11) {
    float k = lampK(vAux);
    float thick = pow(abs(dot(n, V)), 1.6);
    float fall = smoothstep(-0.2, 2.6, vWorld.y) * (1.0 - smoothstep(2.0, 2.7, vWorld.y) * 0.5);
    float a = k * thick * fall * 0.11;
    outColor = vec4(vColor * a, 0.0);
    return;
  }
  if (mat == 2) {
    float k = lampK(vAux);
    col = vColor * (0.05 + 3.6 * k);
  } else if (mat == 3) {
    float k = vAux;
    if (k >= 10.0) {
      float ph = fract(k) * 37.0;
      k = 3.0 * step(0.35, fract(F.cam.w * (0.6 + fract(ph) * 1.8) + ph));
    }
    col = vColor * k;
  } else if (mat == 9) {
    float rim = 1.0 - n.y;
    vec3 sp = spill(vWorld);
    col = vColor * (vec3(0.5, 0.55, 0.7) + mix(vec3(dot(sp, vec3(0.33))), sp, 0.5) * 0.25) + vec3(0.02, 0.03, 0.06) * rim;
  } else if (mat == 6) {
    col = vec3(0.006, 0.01, 0.02) + spill(vWorld) * 0.12 + vec3(0.03, 0.05, 0.09) * pow(1.0 - abs(n.y), 3.0);
    alpha = 0.22;
  } else {
    vec3 albedo = vColor;
    vec2 gloss = vec2(0.0);
    if (mat == 1 || mat == 5) {
      if (mat == 1) { albedo = floorPattern(int(round(vAux)), vWorld.xz, albedo, gloss); }
      else { albedo *= 0.85 + 0.25 * noise2(vWorld.xz * 8.0); gloss = vec2(20.0, 0.2); }
    } else if (mat == 10) {
      gloss = vec2(50.0, 0.5);
    }
    bool floorish = n.y > 0.5 && vWorld.y < 0.05;
    float wrap = floorish ? 0.0 : 0.35;
    vec3 ldiff;
    vec3 lspec;
    lightSum(vWorld, n, V, gloss.x, wrap, ldiff, lspec);
    vec3 amb = ambientAt(n);
    vec2 fd = floorData(vWorld.xz);
    amb += bounceAt(vWorld.xz + n.xz * 0.3) * 0.32;
    float low = 1.0 - smoothstep(0.0, 0.9, vWorld.y);
    float ao = mix(1.0, 1.0 - fd.r * 0.85, low);
    amb *= ao;
    vec3 direct = ldiff * GAIN * mix(1.0, ao, 0.5);
    if (abs(n.y) < 0.5 && mat != 12) {
      float base = mix(0.55, 1.0, smoothstep(0.0, 0.8, vWorld.y));
      amb *= base;
      direct *= mix(0.22, 0.38, smoothstep(0.0, 1.5, vWorld.y));
    }
    vec3 moon = vec3(0.62, 0.78, 1.25) * fd.g * F.ambient.w * low * max(n.y, 0.2);
    col = albedo * (amb + direct + moon) + lspec * GAIN * gloss.y * mix(vec3(1.0), albedo * 3.0, 0.25);
    if (mat == 12) {
      float rim = pow(1.0 - max(dot(n, V), 0.0), 2.5);
      col += albedo * vec3(0.05, 0.06, 0.09) + vec3(0.07, 0.09, 0.15) * rim;
    }
    if (mat == 1) {
      col += vec3(0.01, 0.014, 0.03) * gloss.y * fd.g * 2.0;
    }
  }
  col = mix(col, vec3(2.5), vExtra.w);
  float a = alpha * vExtra.z;
  outColor = vec4(col * a, a);
}
`

export const spriteVs = /* glsl */ `${head}${common}
layout(location = 0) in vec4 sPosSize;
layout(location = 1) in vec4 sColor;
layout(location = 2) in vec4 sMisc;
out vec2 vUv;
out vec4 vColor;
flat out vec4 vMisc;

void main() {
  vec2 corners[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));
  vec2 c = corners[gl_VertexID];
  int kind = int(sMisc.x);
  float size = sPosSize.w;
  vec3 world;
  if ((kind >= 2 && kind <= 6) || kind == 8 || kind == 9) {
    float r = sMisc.y;
    vec2 lc = vec2(c.x * size, c.y * size * (kind == 4 ? max(sMisc.z, 0.001) : 1.0));
    world = sPosSize.xyz + vec3(lc.x * cos(r) - lc.y * sin(r), 0.0, lc.x * sin(r) + lc.y * cos(r));
  } else {
    vec3 toCam = normalize(F.cam.xyz - sPosSize.xyz);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 up = cross(toCam, right);
    world = sPosSize.xyz + (right * c.x + up * c.y) * size + toCam * size * 0.5;
  }
  gl_Position = F.viewProj * vec4(world, 1.0);
  vUv = c;
  vColor = sColor;
  vMisc = sMisc;
}
`

export const spriteFs = /* glsl */ `${head}${common}
in vec2 vUv;
in vec4 vColor;
flat in vec4 vMisc;
out vec4 outColor;

void main() {
  float r = length(vUv);
  int kind = int(vMisc.x);
  float a = 0.0;
  vec3 rgb = vColor.rgb;
  if (kind == 0) {
    a = pow(max(0.0, 1.0 - r), 2.4);
  } else if (kind == 1) {
    float ang = atan(vUv.y, vUv.x) + vMisc.w;
    float sector = floor((ang + 3.14159) / 1.0472);
    float hexR = 0.866 / cos(((ang + 3.14159) - (sector + 0.5) * 1.0472));
    if (r > hexR) { discard; }
    rgb *= 0.65 + 0.35 * hash2(vec2(sector, vMisc.w * 13.0));
    a = 1.0;
  } else if (kind == 2 || kind == 3 || kind == 5) {
    float rr = r;
    if (kind == 3) {
      float ang = atan(vUv.y, vUv.x);
      rr = r + 0.05 * abs(fract(ang * 2.5 + vMisc.w) - 0.5) * 2.0;
    }
    float w = vMisc.z;
    a = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.012, abs(rr - (1.0 - w)));
    if (kind == 5) {
      float ang = atan(vUv.y, vUv.x);
      a *= step(0.5, fract(ang * 9.0 / 3.14159));
    }
  } else if (kind == 4) {
    a = (1.0 - smoothstep(0.6, 1.0, abs(vUv.y))) * (1.0 - smoothstep(0.92, 1.0, abs(vUv.x)));
    if (vMisc.w > 0.5) { a *= step(0.45, fract(vUv.x * vMisc.w)); }
  } else if (kind == 6) {
    a = 1.0 - smoothstep(0.85, 1.0, r);
  } else if (kind == 7) {
    float bar = step(abs(vUv.x), 0.16) * step(-0.2, vUv.y) * step(vUv.y, 0.95);
    float pt = step(length(vUv - vec2(0.0, -0.6)), 0.2);
    a = max(bar, pt);
  } else if (kind == 9) {
    float w = vMisc.z;
    float ang = abs(atan(vUv.y, vUv.x));
    a = (1.0 - smoothstep(w * 0.5, w * 0.5 + 0.012, abs(r - (1.0 - w)))) * (1.0 - smoothstep(vMisc.w - 0.04, vMisc.w, ang));
  } else if (kind == 8) {
    float ang = abs(atan(vUv.y, vUv.x));
    float half_ = vMisc.w;
    float inside = (1.0 - smoothstep(half_ - 0.015, half_, ang)) * (1.0 - smoothstep(0.95, 1.0, r));
    float edge = smoothstep(half_ - 0.07, half_ - 0.015, ang);
    float scan = 0.5 + 0.5 * sin(r * 22.0 - F.cam.w * 7.0);
    a = inside * (0.1 + 0.08 * scan + 0.8 * edge + 0.35 * smoothstep(0.86, 0.96, r));
  }
  if (a <= 0.002) { discard; }
  outColor = vec4(rgb * a * vColor.a, a * vColor.a);
}
`

const postCommon = /* glsl */ `${head}
uniform sampler2D src;
uniform sampler2D bloomTex;
uniform vec4 P;
uniform vec4 G;
in vec2 vUv;
out vec4 outColor;

vec4 clean(vec4 c) {
  bool bad = any(isnan(c)) || any(greaterThan(abs(c), vec4(6e4)));
  return bad ? vec4(0.0) : min(c, vec4(64.0));
}
vec3 S(vec2 uv) { return clean(texture(src, uv)).rgb; }
`

export const downFs = /* glsl */ `${postCommon}
void main() {
  vec2 t = P.xy;
  vec2 uv = vUv;
  vec3 a = S(uv + t * vec2(-2.0, -2.0));
  vec3 b = S(uv + t * vec2(0.0, -2.0));
  vec3 c = S(uv + t * vec2(2.0, -2.0));
  vec3 d = S(uv + t * vec2(-2.0, 0.0));
  vec3 e = S(uv);
  vec3 f = S(uv + t * vec2(2.0, 0.0));
  vec3 g = S(uv + t * vec2(-2.0, 2.0));
  vec3 h = S(uv + t * vec2(0.0, 2.0));
  vec3 i = S(uv + t * vec2(2.0, 2.0));
  vec3 j = S(uv + t * vec2(-1.0, -1.0));
  vec3 k = S(uv + t * vec2(1.0, -1.0));
  vec3 l = S(uv + t * vec2(-1.0, 1.0));
  vec3 m = S(uv + t * vec2(1.0, 1.0));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (P.z > 0.5) {
    float br = max(col.r, max(col.g, col.b));
    float knee = 0.5;
    float th = 0.9;
    float soft = clamp(br - th + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - th) / max(br, 1e-4);
  }
  outColor = vec4(col, 1.0);
}
`

export const upFs = /* glsl */ `${postCommon}
void main() {
  vec2 t = P.xy;
  vec3 c = texture(src, vUv).rgb * 4.0;
  c += (texture(src, vUv + vec2(-t.x, 0.0)).rgb + texture(src, vUv + vec2(t.x, 0.0)).rgb + texture(src, vUv + vec2(0.0, -t.y)).rgb + texture(src, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  c += texture(src, vUv + vec2(-t.x, -t.y)).rgb + texture(src, vUv + vec2(t.x, -t.y)).rgb + texture(src, vUv + vec2(-t.x, t.y)).rgb + texture(src, vUv + vec2(t.x, t.y)).rgb;
  outColor = vec4(c / 16.0, 1.0);
}
`

export const compositeFs = /* glsl */ `${postCommon}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3(0.0), vec3(1.0)); }
float hash(vec2 p) {
  vec2 q = fract(p * vec2(0.1031, 0.1030));
  vec2 r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
void main() {
  vec2 uv = vUv;
  vec2 fromC = uv - 0.5;
  vec2 ca = fromC * dot(fromC, fromC) * 0.012;
  vec3 hdr = vec3(S(uv + ca).r, S(uv).g, S(uv - ca).b);
  vec3 bloom = texture(bloomTex, uv).rgb;
  hdr = hdr + bloom * 0.32;
  vec3 c = aces(hdr * G.w);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 - G.y);
  c += vec3(0.006, 0.011, 0.028) * (1.0 - smoothstep(0.0, 0.25, l));
  c *= mix(vec3(0.93, 0.97, 1.06), vec3(1.04, 1.0, 0.95), smoothstep(0.2, 0.8, l));
  float v = length(fromC * vec2(1.0, 0.8));
  c *= mix(1.0, 0.45, smoothstep(0.32, 0.85, v));
  c = mix(c, vec3(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
  c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  vec2 px = gl_FragCoord.xy;
  float grain = hash(px + fract(G.x * 13.7) * 1000.0) + hash(px * 1.37 + fract(G.x * 7.3) * 500.0) - 1.0;
  c += grain * 0.022 * (1.0 - l * 0.6);
  outColor = vec4(c, 1.0);
}
`
