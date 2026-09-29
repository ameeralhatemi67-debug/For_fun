import { DROP_TAG_LEVELS, MAX_BLOBS } from '../physics/blobBuffer';
import { FIELD_THRESHOLD } from '../physics/shape';

export const fluidVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Full-screen compositing shader:
 *   camera (cover-mapped, mirrored) → metaball field of all blobs → lens-like
 *   liquid body (refraction, internal flow, thin rim, broken highlight) →
 *   restrained glow → fusion shock ring.
 * The field kernel/threshold match src/physics/shape.ts exactly.
 *
 * Color: every blob carries a continuous palette position (0 = body A,
 * 1 = body B); the field-weighted average picks a color on A → purple → B,
 * so the fusion neck renders as blue → violet → red. Blobs tagged as droplets
 * get a thinner lens, less rim/glow and more translucency (torn liquid).
 */
export const fluidFragment = /* glsl */ `
precision highp float;
#define MAX_BLOBS ${MAX_BLOBS}
#define THRESHOLD ${FIELD_THRESHOLD.toFixed(4)}
#define DROP_LEVELS ${DROP_TAG_LEVELS.toFixed(1)}

uniform vec2 uResolution;   // device px
uniform float uPixelRatio;
uniform float uWorldScale;  // css px per world unit
uniform vec2 uViewCss;      // css px
uniform float uTime;

uniform sampler2D uVideo;
uniform float uHasVideo;
uniform vec4 uVideoRect;    // css px: x, y, w, h (object-fit: cover)
uniform float uMirror;
uniform float uBgDim;

uniform int uBlobCount;
uniform vec4 uBlobA[MAX_BLOBS]; // x, y, support, weight
uniform vec4 uBlobB[MAX_BLOBS]; // dirX, dirY, aspect, mix + 2·dropTag

// Palettes: [0] body A, [1] body B, [2] the purple in between.
uniform vec3 uDeep[3];
uniform vec3 uCore[3];
uniform vec3 uRim[3];
uniform vec3 uAccent[3];
uniform vec4 uBodyFx[2];     // flash, energy, flowX, flowY (world)
uniform float uBodyR[2];     // effective radius (world) per body

uniform float uCoreBrightness;
uniform float uEdgeBrightness;
uniform float uRimWidth;     // css px
uniform float uGlowIntensity;
uniform float uGlowRadius;
uniform float uTurbAmount;
uniform float uTurbSpeed;
uniform float uFlowInertia;
uniform float uRefraction;
uniform float uOpacity;

uniform vec4 uShock;         // x, y (world), radius (world), strength
uniform vec3 uShockColor;

// ── noise ────────────────────────────────────────────────────────────────
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
             mix(dot(hash2(i + vec2(0, 1)), f - vec2(0, 1)), dot(hash2(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 4; i++) { s += a * gnoise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

vec3 pal3(vec3 a, vec3 m, vec3 b, float t) {
  return t < 0.5 ? mix(a, m, t * 2.0) : mix(m, b, t * 2.0 - 1.0);
}

vec3 background(vec2 css) {
  // Camera sample (same cover rect + mirror transform the tracker coordinates use).
  float x = uMirror > 0.5 ? uViewCss.x - css.x : css.x;
  vec2 uv = clamp(vec2((x - uVideoRect.x) / uVideoRect.z, (css.y - uVideoRect.y) / uVideoRect.w), 0.0, 1.0);
  vec3 cam = texture2D(uVideo, vec2(uv.x, 1.0 - uv.y)).rgb * (1.0 - uBgDim);
  // No camera: dark studio backdrop with a faint grid so refraction is visible.
  vec2 w = css / uWorldScale;
  vec2 c = uViewCss / uWorldScale * 0.5;
  float vig = 1.0 - 0.55 * smoothstep(0.2, 1.1, length(w - c));
  vec3 studio = mix(vec3(0.018, 0.016, 0.03), vec3(0.06, 0.055, 0.085), vig);
  vec2 g = abs(fract(w * 10.0) - 0.5);
  float line = smoothstep(0.485, 0.5, max(g.x, g.y));
  studio += vec3(0.05, 0.05, 0.075) * line * vig;
  return mix(studio, cam, uHasVideo);
}

void main() {
  vec2 css = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uPixelRatio;
  vec2 p = css / uWorldScale;

  float F = 0.0;      // total field
  float Fm = 0.0;     // Σ field·palette position
  float Fd = 0.0;     // Σ field·droplet tag
  vec2 G = vec2(0.0); // field gradient
  float glow = 0.0;
  float glowM = 0.0;
  float glowK = 1.0 / max(uGlowRadius * uGlowRadius, 1e-3);

  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uBlobCount) break;
    vec4 a = uBlobA[i];
    vec4 b = uBlobB[i];
    float tag = floor(b.w * 0.5);
    float mixv = b.w - 2.0 * tag;
    float drop = tag / DROP_LEVELS;
    vec2 d = p - a.xy;
    float R = a.z;
    float sq = sqrt(b.z);          // area-preserving: along ×√aspect, across ÷√aspect
    vec2 dir = b.xy;
    vec2 perp = vec2(-dir.y, dir.x);
    vec2 v = vec2(dot(d, dir) / sq, dot(d, perp) * sq) / R;
    float q2 = dot(v, v);
    float g = a.w * exp(-q2 * 3.0 * glowK) * (1.0 - 0.8 * drop);
    glow += g;
    glowM += g * mixv;
    if (q2 < 1.0) {
      float t = 1.0 - q2;
      float k = a.w * t * t * t;
      vec2 dq2 = (2.0 / R) * (v.x * dir / sq + v.y * perp * sq);
      G += -a.w * 3.0 * t * t * dq2;
      F += k;
      Fm += k * mixv;
      Fd += k * drop;
    }
  }

  float gl = max(length(G), 1e-4);
  float sd = (F - THRESHOLD) / gl;                       // ≈ signed distance (world), + inside
  float px = 1.0 / uWorldScale;                          // one css px in world units
  float cover = smoothstep(-0.9 * px, 0.9 * px, sd);
  float mixB = F > 1e-5 ? clamp(Fm / F, 0.0, 1.0) : (glow > 1e-5 ? clamp(glowM / glow, 0.0, 1.0) : 0.0);
  float dropK = F > 1e-5 ? clamp(Fd / F, 0.0, 1.0) : 0.0;

  vec3 deep = pal3(uDeep[0], uDeep[2], uDeep[1], mixB);
  vec3 core = pal3(uCore[0], uCore[2], uCore[1], mixB);
  vec3 rimC = pal3(uRim[0], uRim[2], uRim[1], mixB);
  vec3 acc = pal3(uAccent[0], uAccent[2], uAccent[1], mixB);
  vec4 fx = mix(uBodyFx[0], uBodyFx[1], mixB);
  float Rb = mix(uBodyR[0], uBodyR[1], mixB);

  // Lens profile: spherical-cap height from distance to the edge. Droplets are thin lenses.
  float thick = Rb * mix(0.85, 0.28, dropK);
  float h = clamp(sd / thick, 0.0, 1.0);
  float e = 1.0 - h;
  vec2 outward = -G / gl;

  // Internal flow: domain-warped fbm whose origin lags behind the body (flow inertia),
  // so the liquid inside keeps moving after stops and swirls on impacts.
  float ts = uTime * uTurbSpeed;
  vec2 q = (p - fx.zw * uFlowInertia) / Rb * 0.9;
  float n1 = fbm(q + vec2(ts * 0.35, -ts * 0.22));
  float n2 = fbm(q * 1.6 + vec2(n1 * 2.2, -n1 * 1.7) + vec2(-ts * 0.5, ts * 0.3));

  // Surface normal, slightly rippled by the flow so highlights never sit perfectly still.
  vec2 ripple = vec2(n1, n2) * 0.22 * e;
  vec3 n = normalize(vec3(outward * e + ripple, sqrt(max(1.0 - e * e, 0.0)) + 0.05));

  // Shock ring distortion (fusion).
  vec2 shockOff = vec2(0.0);
  float shockLine = 0.0;
  if (uShock.w > 0.001) {
    vec2 sdv = p - uShock.xy;
    float sdist = length(sdv);
    float ring = exp(-pow((sdist - uShock.z) / (Rb * 0.35), 2.0));
    shockOff = (sdv / max(sdist, 1e-4)) * ring * uShock.w * Rb * 0.35;
    shockLine = ring * uShock.w;
  }

  // Refraction: the liquid acts like a lens on the background (droplets a little more).
  vec2 refr = -n.xy * uRefraction * Rb * (0.9 + 0.5 * dropK) * cover;
  vec3 bg = background((p + refr + shockOff) * uWorldScale);

  vec3 col = bg;
  if (F > THRESHOLD * 0.25) {
    float turb = uTurbAmount * (0.8 + 0.6 * fx.y);

    float coreMask = smoothstep(THRESHOLD * 1.2, THRESHOLD * 4.0, F) * (0.55 + 0.45 * h) * (1.0 - 0.5 * dropK);
    vec3 body = deep * (0.72 + 0.5 * h);
    float swirl = clamp(0.5 + n2 * 1.25 * turb, 0.0, 1.0);
    body = mix(body, core, clamp(coreMask * swirl * uCoreBrightness, 0.0, 1.0));
    float veins = pow(clamp(1.0 - abs(n2 * 3.2), 0.0, 1.0), 6.0) * turb * (0.35 + 0.65 * h);
    body += core * veins * 0.6 * uCoreBrightness * (1.0 - 0.4 * dropK);
    float cool = smoothstep(0.18, 0.42, n1) * 0.55 * turb;
    body = mix(body, acc, cool * (0.4 + 0.6 * h));
    // Energy flash (fusion charge / release / spawn): saturated core glow, a hint of white at the center.
    float flashMask = smoothstep(THRESHOLD, THRESHOLD * 3.5, F) * (0.4 + 0.6 * h);
    body += core * fx.x * flashMask * 0.75;
    body += vec3(1.0, 0.92, 1.0) * fx.x * fx.x * pow(flashMask, 3.0) * 0.25;

    // Light: a soft, flow-broken highlight and a thin fresnel rim (liquid, not glass).
    vec3 L = normalize(vec3(-0.45, -0.6, 0.75));
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
    spec *= 0.35 + 0.65 * smoothstep(0.25, 0.75, swirl);
    float fres = pow(e, 3.0);
    float rimW = uRimWidth * px;
    float rim = exp(-max(sd, 0.0) / rimW);

    float alpha = uOpacity * mix(0.62, 0.97, h) * (1.0 - 0.3 * dropK);
    col = mix(bg, body, alpha);
    col += rimC * (rim * 0.72 + fres * 0.22) * uEdgeBrightness * (1.0 - 0.65 * dropK);
    col += vec3(1.0) * spec * 0.32 * (1.0 - 0.5 * dropK);
    col = mix(bg, col, cover);
  }

  // Restrained outer glow following the silhouette.
  vec3 glowCol = mix(core, rimC, 0.35);
  float outside = 1.0 - cover;
  col += glowCol * glow * uGlowIntensity * 0.45 * outside;
  col += uShockColor * shockLine * 0.35;

  gl_FragColor = vec4(col, 1.0);
}
`;
