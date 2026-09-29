import { MAX_BLOBS } from '../physics/blobBuffer';
import { FIELD_THRESHOLD } from '../physics/shape';

export const fluidVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Full-screen compositing shader:
 *   camera (cover-mapped, mirrored) → metaball field of all blobs → lens-like
 *   liquid body (refraction, internal turbulence, thin rim, spec) → restrained glow
 *   → fusion shock ring.
 * The field kernel/threshold match src/physics/shape.ts exactly.
 */
export const fluidFragment = /* glsl */ `
precision highp float;
#define MAX_BLOBS ${MAX_BLOBS}
#define THRESHOLD ${FIELD_THRESHOLD.toFixed(4)}

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
uniform vec4 uBlobB[MAX_BLOBS]; // dirX, dirY, stretch, body

uniform vec3 uDeep[2];
uniform vec3 uCore[2];
uniform vec3 uRim[2];
uniform vec3 uAccent[2];
uniform vec4 uBodyFx[2];     // flash, turbulence energy, unused, unused
uniform float uBaseRadius;   // world units

uniform float uCoreBrightness;
uniform float uEdgeBrightness;
uniform float uRimWidth;     // css px
uniform float uGlowIntensity;
uniform float uGlowRadius;
uniform float uTurbAmount;
uniform float uTurbSpeed;
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
  float F1 = 0.0;     // field of body 1 (for color mixing)
  vec2 G = vec2(0.0); // field gradient
  float glow = 0.0;
  float glow1 = 0.0;
  float glowK = 1.0 / max(uGlowRadius * uGlowRadius, 1e-3);

  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uBlobCount) break;
    vec4 a = uBlobA[i];
    vec4 b = uBlobB[i];
    vec2 d = p - a.xy;
    float R = a.z;
    float st = b.z;
    float sq = sqrt(st);
    vec2 dir = b.xy;
    vec2 perp = vec2(-dir.y, dir.x);
    vec2 v = vec2(dot(d, dir) / st, dot(d, perp) * sq) / R;
    float q2 = dot(v, v);
    float g = a.w * exp(-q2 * 3.0 * glowK);
    glow += g;
    if (b.w > 0.5) glow1 += g;
    if (q2 < 1.0) {
      float t = 1.0 - q2;
      float k = a.w * t * t * t;
      vec2 dq2 = (2.0 / R) * (v.x * dir / st + v.y * perp * sq);
      G += -a.w * 3.0 * t * t * dq2;
      F += k;
      if (b.w > 0.5) F1 += k;
    }
  }

  float gl = max(length(G), 1e-4);
  float sd = (F - THRESHOLD) / gl;                       // ≈ signed distance (world), + inside
  float px = 1.0 / uWorldScale;                          // one css px in world units
  float cover = smoothstep(-0.9 * px, 0.9 * px, sd);
  float mixB = F > 1e-5 ? clamp(F1 / F, 0.0, 1.0) : (glow > 1e-5 ? clamp(glow1 / glow, 0.0, 1.0) : 0.0);

  vec3 deep = mix(uDeep[0], uDeep[1], mixB);
  vec3 core = mix(uCore[0], uCore[1], mixB);
  vec3 rimC = mix(uRim[0], uRim[1], mixB);
  vec3 acc = mix(uAccent[0], uAccent[1], mixB);
  vec4 fx = mix(uBodyFx[0], uBodyFx[1], mixB);

  // Lens profile: spherical-cap height from distance to the edge.
  float thick = uBaseRadius * 0.9;
  float h = clamp(sd / thick, 0.0, 1.0);
  float e = 1.0 - h;
  vec2 outward = -G / gl;
  vec3 n = normalize(vec3(outward * e, sqrt(max(1.0 - e * e, 0.0)) + 0.05));

  // Shock ring distortion (fusion).
  vec2 shockOff = vec2(0.0);
  float shockLine = 0.0;
  if (uShock.w > 0.001) {
    vec2 sdv = p - uShock.xy;
    float sdist = length(sdv);
    float ring = exp(-pow((sdist - uShock.z) / (uBaseRadius * 0.35), 2.0));
    shockOff = (sdv / max(sdist, 1e-4)) * ring * uShock.w * uBaseRadius * 0.35;
    shockLine = ring * uShock.w;
  }

  // Refraction: the liquid acts like a lens on the background.
  vec2 refr = -n.xy * uRefraction * uBaseRadius * 0.9 * cover;
  vec3 bg = background((p + refr + shockOff) * uWorldScale);

  vec3 col = bg;
  if (F > THRESHOLD * 0.25) {
    // Internal procedural flow (domain-warped fbm drifting through the body).
    float ts = uTime * uTurbSpeed;
    vec2 q = p / uBaseRadius * 0.9;
    float n1 = fbm(q + vec2(ts * 0.35, -ts * 0.22));
    float n2 = fbm(q * 1.6 + vec2(n1 * 2.2, -n1 * 1.7) + vec2(-ts * 0.5, ts * 0.3));
    float turb = uTurbAmount * (0.8 + 0.6 * fx.y);

    float coreMask = smoothstep(THRESHOLD * 1.2, THRESHOLD * 4.0, F) * (0.55 + 0.45 * h);
    vec3 body = deep * (0.75 + 0.5 * h);
    float swirl = clamp(0.5 + n2 * 1.25 * turb, 0.0, 1.0);
    body = mix(body, core, clamp(coreMask * swirl * uCoreBrightness, 0.0, 1.0));
    float veins = pow(clamp(1.0 - abs(n2 * 3.2), 0.0, 1.0), 6.0) * turb * (0.35 + 0.65 * h);
    body += core * veins * 0.55 * uCoreBrightness;
    float cool = smoothstep(0.18, 0.42, n1) * 0.55 * turb;
    body = mix(body, acc, cool * (0.4 + 0.6 * h));
    // Energy flash (fusion charge / release): saturated core glow, only a hint of white at the very center.
    float flashMask = smoothstep(THRESHOLD, THRESHOLD * 3.5, F) * (0.4 + 0.6 * h);
    body += core * fx.x * flashMask * 0.75;
    body += vec3(1.0, 0.92, 1.0) * fx.x * fx.x * pow(flashMask, 3.0) * 0.25;

    // Light: soft specular from the upper left, fresnel-brightened thin rim.
    vec3 L = normalize(vec3(-0.45, -0.6, 0.75));
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 36.0);
    float fres = pow(e, 3.0);
    float rimW = uRimWidth * px;
    float rim = exp(-max(sd, 0.0) / rimW);

    float alpha = uOpacity * mix(0.72, 1.0, h);
    col = mix(bg, body, alpha);
    col += rimC * (rim * 0.9 + fres * 0.35) * uEdgeBrightness;
    col += vec3(1.0) * spec * 0.55;
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
