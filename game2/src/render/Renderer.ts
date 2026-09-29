import * as THREE from 'three';
import type { CoverRect } from '../camera/CameraController';
import type { Settings } from '../config/schema';
import { BLOB_STRIDE, MAX_BLOBS, type BlobBuffer } from '../physics/blobBuffer';
import { fluidFragment, fluidVertex } from './fluidShader';

// The shader works directly in display (sRGB) space; keep THREE from linearizing hex colors.
THREE.ColorManagement.enabled = false;

export interface Palette {
  deep: THREE.Color;
  core: THREE.Color;
  rim: THREE.Color;
  accent: THREE.Color;
}

const pal = (deep: string, core: string, rim: string, accent: string): Palette => ({
  deep: new THREE.Color(deep),
  core: new THREE.Color(core),
  rim: new THREE.Color(rim),
  accent: new THREE.Color(accent),
});

// Colors are treated as display-space values (no color management in this shader).
export const PALETTES = {
  purple: pal('#26073f', '#c24dff', '#e9c8ff', '#5d7dff'),
  blue: pal('#061a4a', '#3a8dff', '#cfe8ff', '#34e0ff'),
  red: pal('#4a0710', '#ff3d2e', '#ffd6c2', '#ff9a1f'),
};

export interface BodyLook {
  /** Base palette blended toward purple by `purpleMix`. */
  base: Palette;
  purpleMix: number;
  flash: number;
  energy: number;
}

export interface FrameView {
  cssW: number;
  cssH: number;
  worldScale: number;
  time: number;
  video: HTMLVideoElement | null;
  videoRect: CoverRect;
  mirror: boolean;
  shock: { x: number; y: number; r: number; strength: number };
}

/**
 * Owns the WebGL canvas. Everything (camera + effect) is composited into this
 * one canvas so in-browser recording captures exactly what is seen.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private videoTex: THREE.VideoTexture | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private blobA: THREE.Vector4[] = [];
  private blobB: THREE.Vector4[] = [];
  private pixelRatio = 1;
  private tmp = new THREE.Color();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-canvas';
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    for (let i = 0; i < MAX_BLOBS; i++) {
      this.blobA.push(new THREE.Vector4());
      this.blobB.push(new THREE.Vector4(1, 0, 1, 0));
    }
    const v3 = () => [new THREE.Vector3(), new THREE.Vector3()];
    this.material = new THREE.ShaderMaterial({
      vertexShader: fluidVertex,
      fragmentShader: fluidFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPixelRatio: { value: 1 },
        uWorldScale: { value: 1 },
        uViewCss: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uVideo: { value: null },
        uHasVideo: { value: 0 },
        uVideoRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uMirror: { value: 1 },
        uBgDim: { value: 0 },
        uBlobCount: { value: 0 },
        uBlobA: { value: this.blobA },
        uBlobB: { value: this.blobB },
        uDeep: { value: v3() },
        uCore: { value: v3() },
        uRim: { value: v3() },
        uAccent: { value: v3() },
        uBodyFx: { value: [new THREE.Vector4(), new THREE.Vector4()] },
        uBaseRadius: { value: 0.07 },
        uCoreBrightness: { value: 1 },
        uEdgeBrightness: { value: 1 },
        uRimWidth: { value: 2 },
        uGlowIntensity: { value: 0.4 },
        uGlowRadius: { value: 1 },
        uTurbAmount: { value: 1 },
        uTurbSpeed: { value: 0.5 },
        uRefraction: { value: 0.3 },
        uOpacity: { value: 0.9 },
        uShock: { value: new THREE.Vector4() },
        uShockColor: { value: new THREE.Vector3(0.8, 0.6, 1) },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  resize(cssW: number, cssH: number, maxPixelRatio: number): void {
    const pr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(cssW, cssH, false);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  private bindVideo(video: HTMLVideoElement | null): void {
    if (video === this.videoEl) return;
    this.videoTex?.dispose();
    this.videoTex = null;
    this.videoEl = video;
    if (video) {
      this.videoTex = new THREE.VideoTexture(video);
      this.videoTex.minFilter = THREE.LinearFilter;
      this.videoTex.magFilter = THREE.LinearFilter;
      this.videoTex.generateMipmaps = false;
    }
    this.material.uniforms.uVideo.value = this.videoTex;
  }

  render(view: FrameView, blobs: BlobBuffer, looks: readonly [BodyLook, BodyLook], s: Settings): void {
    const u = this.material.uniforms;
    const hasVideo = !!view.video && view.video.readyState >= 2 && view.video.videoWidth > 0;
    this.bindVideo(hasVideo ? view.video : null);

    this.renderer.getDrawingBufferSize(u.uResolution.value);
    u.uPixelRatio.value = this.pixelRatio;
    u.uWorldScale.value = view.worldScale;
    u.uViewCss.value.set(view.cssW, view.cssH);
    u.uTime.value = view.time;
    u.uHasVideo.value = hasVideo ? 1 : 0;
    u.uVideoRect.value.set(view.videoRect.x, view.videoRect.y, view.videoRect.w, view.videoRect.h);
    u.uMirror.value = view.mirror ? 1 : 0;
    u.uBgDim.value = s.backgroundDim;

    const d = blobs.data;
    u.uBlobCount.value = blobs.count;
    for (let i = 0; i < blobs.count; i++) {
      const o = i * BLOB_STRIDE;
      this.blobA[i].set(d[o], d[o + 1], d[o + 2], d[o + 3]);
      this.blobB[i].set(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    }

    for (let b = 0; b < 2; b++) {
      const look = looks[b];
      const m = look.purpleMix;
      this.setMixed(u.uDeep.value[b], look.base.deep, PALETTES.purple.deep, m);
      this.setMixed(u.uCore.value[b], look.base.core, PALETTES.purple.core, m);
      this.setMixed(u.uRim.value[b], look.base.rim, PALETTES.purple.rim, m);
      this.setMixed(u.uAccent.value[b], look.base.accent, PALETTES.purple.accent, m);
      u.uBodyFx.value[b].set(look.flash, look.energy, 0, 0);
    }

    u.uBaseRadius.value = s.baseRadius;
    u.uCoreBrightness.value = s.coreBrightness;
    u.uEdgeBrightness.value = s.edgeBrightness;
    u.uRimWidth.value = s.rimWidth;
    u.uGlowIntensity.value = s.glowIntensity;
    u.uGlowRadius.value = s.glowRadius;
    u.uTurbAmount.value = s.turbulenceAmount;
    u.uTurbSpeed.value = s.turbulenceSpeed;
    u.uRefraction.value = s.refraction;
    u.uOpacity.value = s.bodyOpacity;
    u.uShock.value.set(view.shock.x, view.shock.y, view.shock.r, view.shock.strength);

    this.renderer.render(this.scene, this.camera);
  }

  private setMixed(out: THREE.Vector3, a: THREE.Color, b: THREE.Color, t: number): void {
    this.tmp.copy(a).lerp(b, t);
    out.set(this.tmp.r, this.tmp.g, this.tmp.b);
  }

  dispose(): void {
    this.videoTex?.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}
