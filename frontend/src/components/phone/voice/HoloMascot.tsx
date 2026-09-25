"use client";

import * as React from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { VoiceSessionState } from "@/types";

/**
 * HOLO: JARVIS's voice-mode mascot. A little hologram robot projected from a
 * pad, with a glass visor for a face.
 *
 * Everything it does is driven by the real session: the microphone level
 * while you talk (eyes widen, ears pulse, an "o" mouth), JARVIS's own
 * playback while it speaks (a waveform mouth, nodding along), thinking (eyes
 * drift up, a loading ring spins round its head), muted (eyes shut, colour
 * drains, head droops). Tap it and it squashes, glitches and grins.
 *
 * Kept cheap for a phone: one small canvas (pixel ratio capped at 2 and
 * lowered if frames run long), about a dozen draw calls, shaders compiled in
 * the background with `compileAsync` so opening voice mode never stalls, a
 * pause whenever the page is hidden, and single still frames under reduced
 * motion. Everything runs from refs; React never re-renders per frame.
 */

type Mood = {
  open: number;
  happy: number;
  sleepy: number;
  brow: number;
  browTilt: number;
  browAsym: number;
  blush: number;
  ring: number;
  spin: number;
  lookX: number;
  lookY: number;
  tilt: number;
  droop: number;
  glow: number;
  glitch: number;
};

/*
 * Expression per state. HOLO's body keeps one identity colour; the state
 * shows in its face (eyes, brows, blush, mouth), its eye colour and its body
 * language. `brow` raises both brows, `browTilt` lifts their inner ends
 * (friendly, a little pleading), `browAsym` raises one and drops the other.
 */
const MOODS: Record<string, Mood> = {
  idle: { open: 0.55, happy: 0, sleepy: 0.25, brow: -0.35, browTilt: 0, browAsym: 0, blush: 0, ring: 0, spin: 0.3, lookX: 0, lookY: -0.25, tilt: 0, droop: 0.08, glow: 0.5, glitch: 0.08 },
  connecting: { open: 0.85, happy: 0, sleepy: 0, brow: 0.1, browTilt: 0, browAsym: 0, blush: 0, ring: 0.6, spin: 1.8, lookX: 0, lookY: 0.1, tilt: 0, droop: 0, glow: 0.8, glitch: 0.3 },
  listening: { open: 1, happy: 0, sleepy: 0, brow: 0.3, browTilt: 0.35, browAsym: 0, blush: 0.2, ring: 0, spin: 0.4, lookX: 0, lookY: 0, tilt: 0.06, droop: 0, glow: 0.9, glitch: 0.02 },
  hearing: { open: 1.12, happy: 0, sleepy: 0, brow: 0.7, browTilt: 0.2, browAsym: 0, blush: 0.1, ring: 0, spin: 0.6, lookX: 0, lookY: 0.05, tilt: 0.1, droop: -0.03, glow: 1, glitch: 0.03 },
  thinking: { open: 0.85, happy: 0, sleepy: 0, brow: 0.25, browTilt: 0, browAsym: 0.45, blush: 0, ring: 0.95, spin: 2.6, lookX: 0.55, lookY: 0.6, tilt: -0.08, droop: -0.04, glow: 0.95, glitch: 0.06 },
  speaking: { open: 0.95, happy: 0.3, sleepy: 0, brow: 0.35, browTilt: 0.25, browAsym: 0, blush: 0.45, ring: 0, spin: 0.9, lookX: 0, lookY: 0, tilt: 0, droop: 0, glow: 1, glitch: 0.03 },
  muted: { open: 0.2, happy: 0, sleepy: 1, brow: -0.45, browTilt: -0.1, browAsym: 0, blush: 0, ring: 0, spin: 0.2, lookX: 0, lookY: -0.3, tilt: -0.05, droop: 0.14, glow: 0.42, glitch: 0.02 },
};

/** HOLO's own colours (its "skin"), the same in every state. */
const BODY: [string, string] = ["#38E1FF", "#8F7CFF"];

/** Eye and accent colour per state. */
const ACCENT: Record<string, string> = {
  idle: "#8FA8C8",
  connecting: "#9FF2FF",
  listening: "#9FF2FF",
  hearing: "#D4FF3A",
  thinking: "#D9C9FF",
  speaking: "#FFC2EA",
  muted: "#C9CDD4",
};

/** Which mouth each state wears: smile, "o", talking, "hmm", flat. */
const MOUTHS: Record<string, [number, number, number, number, number]> = {
  idle: [0.35, 0, 0, 0, 0.65],
  connecting: [0, 1, 0, 0, 0],
  listening: [1, 0, 0, 0, 0],
  hearing: [0, 1, 0, 0, 0],
  thinking: [0, 0, 0, 1, 0],
  speaking: [0, 0, 1, 0, 0],
  muted: [0, 0, 0, 0, 1],
};

function color(hex: string): THREE.Vector3 {
  const value = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

const HEAD = { w: 1.72, h: 1.42, d: 1.3 };

/* ------------------------------------------------------------------ shaders */

const SHELL_VERTEX = `
uniform float uTime;
uniform float uGlitch;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vWorld;
varying vec3 vLocal;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec3 p = position;
  // Glitch: thin horizontal slices jump sideways for a moment.
  float slice = floor((p.y + floor(uTime * 12.0) * 0.37) * 14.0);
  float jump = step(0.9, hash(slice + floor(uTime * 20.0)));
  p.x += jump * uGlitch * 0.16 * (hash(slice * 3.1) - 0.5);
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vLocal = position;
  vec4 mv = viewMatrix * world;
  vViewDir = normalize(-mv.xyz);
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

const SHELL_FRAGMENT = `
precision highp float;
uniform float uTime;
uniform float uReveal;
uniform float uLevel;
uniform float uGlow;
uniform float uMuted;
uniform float uFlicker;
uniform float uHeight;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vWorld;
varying vec3 vLocal;
void main() {
  float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
  float fres = pow(1.0 - facing, 2.2);
  float scan = 0.5 + 0.5 * sin(vWorld.y * 70.0 - uTime * 7.0);
  float band = fract(vWorld.y * 0.55 - uTime * 0.42);
  float sweep = smoothstep(0.0, 0.05, band) * (1.0 - smoothstep(0.05, 0.16, band));
  float hue = clamp(vLocal.y / uHeight + 0.5 + 0.18 * sin(uTime * 0.6 + vLocal.x * 2.2), 0.0, 1.0);
  vec3 col = mix(uA, uB, hue);
  col = mix(col, uC, fres * 0.55);
  // A lit, candy-glass body: brighter on top, a solid fill and a crisp rim,
  // with only a whisper of scanlines.
  col *= 0.72 + 0.4 * clamp(vLocal.y / uHeight + 0.5, 0.0, 1.0);
  float alpha = (0.22 + 0.78 * fres) * (0.9 + 0.1 * smoothstep(0.3, 0.7, scan)) + sweep * 0.1;
  alpha *= 0.6 + 0.4 * uGlow + 0.2 * uLevel;
  // Materialise from the bottom up, with a bright scan edge.
  float h = vLocal.y / uHeight + 0.5;
  float edge = uReveal * 1.25 - 0.12;
  float shown = step(h, edge);
  float edgeGlow = exp(-abs(h - edge) * 38.0) * (1.0 - step(0.999, uReveal));
  alpha = alpha * shown + edgeGlow;
  col += edgeGlow * 0.8;
  float grey = dot(col, vec3(0.333));
  col = mix(col, vec3(grey) * 0.75, uMuted * 0.8);
  alpha *= uFlicker;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

const FACE_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FACE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform vec2 uSize;
uniform float uTime;
uniform float uOpen;
uniform float uHappy;
uniform float uSleepy;
uniform float uGrin;
uniform vec2 uLook;
uniform float uLevel;
uniform float uBrow;
uniform float uBrowTilt;
uniform float uBrowAsym;
uniform float uBlush;
uniform float uSmile;
uniform float uOh;
uniform float uTalk;
uniform float uHmm;
uniform float uFlat;
uniform vec3 uEye;
uniform vec3 uRim;
uniform float uReveal;
uniform float uMuted;
uniform float uFlicker;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// Top half of a ring: the "^" of a happy eye.
float sdArcTop(vec2 p, float r, float th) {
  if (p.y > 0.0) return abs(length(p) - r) - th;
  return length(vec2(abs(p.x) - r, p.y)) - th;
}
// Bottom half of a ring: a smile, or a closed, sleepy eye.
float sdArcBottom(vec2 p, float r, float th) {
  if (p.y < 0.0) return abs(length(p) - r) - th;
  return length(vec2(abs(p.x) - r, p.y)) - th;
}
vec2 rotate(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float eye(vec2 p, vec2 c) {
  vec2 q = p - c;
  float halfHeight = max(0.014, 0.15 * uOpen);
  float open = sdRoundBox(q, vec2(0.078, halfHeight), min(0.078, halfHeight));
  float happy = sdArcTop(q + vec2(0.0, 0.05), 0.088, 0.026);
  float sleepy = sdArcBottom(q - vec2(0.0, 0.035), 0.08, 0.022);
  return mix(mix(open, happy, uHappy), sleepy, uSleepy);
}

float brow(vec2 p, vec2 c, float side) {
  // side: -1 left, 1 right. Tilt lifts the inner end; asym raises the left one.
  float raise = uBrow * 0.045 + uBrowAsym * side * -0.035;
  // Rotating the coordinates turns the shape the other way: a positive tilt
  // lifts the inner ends (friendly), never the angry V.
  float angle = side * (uBrowTilt * 0.35 - uBrowAsym * 0.25);
  vec2 q = rotate(p - (c + vec2(0.0, 0.215 + raise)), angle);
  // A gentle arch: the ends dip, the middle rises.
  q.y += 1.1 * q.x * q.x;
  return sdRoundBox(q, vec2(0.068, 0.014), 0.014);
}

void main() {
  vec2 p = (vUv - 0.5) * uSize;
  float visor = sdRoundBox(p, uSize * 0.5 - 0.02, 0.26);
  float inside = smoothstep(0.004, -0.004, visor);
  float rim = exp(-abs(visor) * 80.0);

  vec2 look = uLook * vec2(0.07, 0.05);
  vec2 left = vec2(-0.25, 0.06) + look;
  vec2 right = vec2(0.25, 0.06) + look;
  float eyes = min(eye(p, left), eye(p, right));
  float brows = min(brow(p, left, -1.0), brow(p, right, 1.0));

  vec2 m = vec2(0.0, -0.22) + look * 0.4;
  vec2 q = p - m;
  float smile = sdArcBottom(q - vec2(0.0, 0.075), 0.095, 0.021);
  // Booped: a wide, open grin.
  float grin = max(length(q * vec2(1.0, 1.45) - vec2(0.0, 0.02)) - 0.1, q.y - 0.03);
  smile = mix(smile, grin, uGrin);
  float oh = abs(length(q * vec2(1.0, 0.9)) - (0.032 + 0.05 * uLevel)) - 0.019;
  // Talking: a mouth that opens and closes with JARVIS's voice.
  float talk = sdRoundBox(q, vec2(0.058 + 0.018 * uLevel, 0.012 + 0.062 * uLevel), 0.02 + 0.03 * uLevel);
  float hmm = sdRoundBox(rotate(q - vec2(0.035, 0.005), 0.22), vec2(0.055, 0.011), 0.011);
  float line = sdRoundBox(q, vec2(0.06, 0.01), 0.01);
  float total = max(0.001, uSmile + uOh + uTalk + uHmm + uFlat);
  float mouth = (smile * uSmile + oh * uOh + talk * uTalk + hmm * uHmm + line * uFlat) / total;

  float features = min(min(eyes, mouth), brows);
  float core = smoothstep(0.005, -0.002, features);
  float halo = exp(-max(features, 0.0) * 34.0) * 0.5;
  // Two glints in each open eye.
  vec2 g1 = vec2(-0.026, 0.06 * uOpen);
  vec2 g2 = vec2(0.024, -0.035 * uOpen);
  float glint = smoothstep(0.02, 0.0, min(length(p - left - g1), length(p - right - g1)));
  glint += 0.6 * smoothstep(0.011, 0.0, min(length(p - left - g2), length(p - right - g2)));
  glint *= (1.0 - uHappy) * (1.0 - uSleepy) * step(0.35, uOpen);
  // Cheeks.
  vec2 cheek = vec2(0.36, -0.1);
  float blush = exp(-dot((p - vec2(-cheek.x, cheek.y)) * vec2(1.0, 1.6), (p - vec2(-cheek.x, cheek.y)) * vec2(1.0, 1.6)) * 60.0);
  blush += exp(-dot((p - cheek) * vec2(1.0, 1.6), (p - cheek) * vec2(1.0, 1.6)) * 60.0);
  blush *= uBlush;

  float scan = 0.9 + 0.1 * sin(vUv.y * 190.0 - uTime * 9.0);
  vec3 eyeCol = mix(uEye, vec3(0.8), uMuted * 0.6);
  vec3 glow = eyeCol * (core * 1.35 + halo) * scan + vec3(glint) * 0.95 + vec3(1.0, 0.42, 0.72) * blush * 0.55;
  vec3 tint = vec3(0.01, 0.018, 0.045);
  float tintA = inside * 0.84;
  // A soft reflection across the glass.
  float sheen = smoothstep(0.02, 0.0, abs(p.y - p.x * 0.35 - 0.3)) * 0.05 * smoothstep(0.3, -0.2, p.x);

  float h = vUv.y;
  float edge = uReveal * 1.25 - 0.2;
  float shown = step(h, edge);

  vec3 col = (tint * tintA + (glow + vec3(sheen)) * inside + uRim * rim * 0.85) * shown * uFlicker;
  float a = (tintA + rim * 0.45) * shown;
  gl_FragColor = vec4(col, a);
}
`;

const GLOW_FRAGMENT = `
precision highp float;
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vNormalV;
varying vec3 vViewDir;
void main() {
  float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
  float a = (0.35 + 0.65 * pow(facing, 1.5)) * uIntensity;
  gl_FragColor = vec4(uColor * a, a);
}
`;

const GLOW_VERTEX = `
varying vec3 vNormalV;
varying vec3 vViewDir;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mv.xyz);
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

const RING_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uSpin;
uniform float uAmount;
uniform vec3 uColor;
void main() {
  float u = fract(vUv.x - uTime * uSpin * 0.08);
  float dash = step(0.42, fract(u * 30.0));
  float comet = exp(-u * 9.0);
  float a = (dash * 0.45 + comet * 1.4) * uAmount;
  gl_FragColor = vec4(uColor * a, a);
}
`;

const PAD_VERTEX = `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PAD_FRAGMENT = `
precision highp float;
varying vec2 vPos;
uniform float uTime;
uniform float uLevel;
uniform float uReveal;
uniform vec3 uColor;
uniform vec3 uAccent;
void main() {
  float r = length(vPos);
  float rings = smoothstep(0.35, 0.5, 0.5 + 0.5 * sin(r * 34.0 - uTime * 3.0));
  float fade = 1.0 - smoothstep(0.7, 1.05, r);
  float core = exp(-r * 3.2);
  float spokes = smoothstep(0.92, 1.0, abs(sin(atan(vPos.y, vPos.x) * 6.0 + uTime * 0.7)));
  float a = (rings * 0.28 + core * 0.55 + spokes * 0.12 * (1.0 - r)) * fade * (0.6 + 0.6 * uLevel) * min(1.0, uReveal * 3.0);
  vec3 col = mix(uColor, uAccent, core);
  gl_FragColor = vec4(col * a, a);
}
`;

const BEAM_VERTEX = `
varying vec2 vUv;
varying float vEdge;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vEdge = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;

const BEAM_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying float vEdge;
uniform float uTime;
uniform float uLevel;
uniform float uReveal;
uniform vec3 uColor;
void main() {
  float up = pow(1.0 - vUv.y, 1.25);
  float streaks = 0.75 + 0.25 * sin(vUv.x * 60.0 + uTime * 2.0) * sin(vUv.x * 23.0 - uTime * 1.3);
  float a = up * (0.08 + 0.3 * pow(vEdge, 1.4)) * streaks * (0.7 + 0.5 * uLevel) * min(1.0, uReveal * 2.0);
  gl_FragColor = vec4(uColor * a, a);
}
`;

const DUST_VERTEX = `
attribute vec3 seed;
uniform float uTime;
uniform float uSpeed;
uniform float uScale;
varying float vAlpha;
void main() {
  float life = fract(seed.x + uTime * uSpeed * (0.55 + seed.y * 0.9));
  float y = -1.55 + life * 1.5;
  float radius = mix(0.62, 0.95, life) * sqrt(seed.z);
  float angle = seed.y * 6.2831 + uTime * 0.5 * (seed.x - 0.5);
  vec3 p = vec3(cos(angle) * radius, y, sin(angle) * radius);
  vAlpha = sin(life * 3.14159) * (0.35 + 0.65 * seed.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (1.6 + 2.6 * seed.x) * uScale * (6.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const DUST_FRAGMENT = `
precision highp float;
uniform vec3 uColor;
uniform float uReveal;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vAlpha * uReveal;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/* ------------------------------------------------------------------ component */

export interface HoloMascotProps {
  state: VoiceSessionState;
  muted: boolean;
  /** Microphone level, updated by the session outside React. */
  levelRef: React.MutableRefObject<number>;
  /** JARVIS's playback level. */
  outputLevel: () => number;
  /** Square canvas size, CSS pixels. */
  size: number;
  /** Bump to make it react to a tap. */
  boop?: number;
  onReady?: (ready: boolean) => void;
  className?: string;
}

export function HoloMascot({ state, muted, levelRef, outputLevel, size, boop = 0, onReady, className }: HoloMascotProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const live = React.useRef({ state, muted, outputLevel, onReady, boop });
  live.current = { state, muted, outputLevel, onReady, boop };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "high-performance" });
    } catch {
      live.current.onReady?.(false);
      return;
    }
    let quality = 1;
    const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 2) * quality;
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
    camera.position.set(0, 0.25, 6.6);
    camera.lookAt(0, -0.1, 0);

    const disposables: Array<{ dispose: () => void }> = [];
    const keep = <T extends { dispose: () => void }>(item: T) => {
      disposables.push(item);
      return item;
    };

    const accents = Object.fromEntries(Object.entries(ACCENT).map(([name, hex]) => [name, color(hex)])) as Record<string, THREE.Vector3>;
    const white = new THREE.Vector3(1, 1, 1);
    const palette = [color(BODY[0]), color(BODY[1]), color(ACCENT.idle)];
    const time = { value: Math.random() * 20 };
    const reveal = { value: reduced ? 1 : 0 };
    const flicker = { value: 1 };
    const level = { value: 0 };
    const muteness = { value: 0 };

    /* The bot: head, face, ears and antenna float; rings orbit it. */
    const bot = new THREE.Group();
    bot.position.y = 0.3;
    scene.add(bot);
    const head = new THREE.Group();
    bot.add(head);

    const headGeometry = keep(new RoundedBoxGeometry(HEAD.w, HEAD.h, HEAD.d, 6, 0.5));
    // Depth-only copy just inside the shell, so rings and dust pass behind the head.
    const occluder = new THREE.Mesh(headGeometry, keep(new THREE.MeshBasicMaterial({ colorWrite: false })));
    occluder.scale.setScalar(0.97);
    occluder.renderOrder = 0;
    head.add(occluder);

    const shellMaterial = keep(
      new THREE.ShaderMaterial({
        vertexShader: SHELL_VERTEX,
        fragmentShader: SHELL_FRAGMENT,
        uniforms: {
          uTime: time, uReveal: reveal, uLevel: level, uMuted: muteness, uFlicker: flicker,
          uGlow: { value: 0.5 }, uGlitch: { value: 0 }, uHeight: { value: HEAD.h },
          uA: { value: palette[0] }, uB: { value: palette[1] }, uC: { value: palette[2] },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
      }),
    );
    const shell = new THREE.Mesh(headGeometry, shellMaterial);
    shell.renderOrder = 1;
    head.add(shell);

    const faceSize = new THREE.Vector2(1.34, 0.98);
    const faceMaterial = keep(
      new THREE.ShaderMaterial({
        vertexShader: FACE_VERTEX,
        fragmentShader: FACE_FRAGMENT,
        uniforms: {
          uSize: { value: faceSize }, uTime: time, uReveal: reveal, uMuted: muteness, uFlicker: flicker, uLevel: level,
          uOpen: { value: 1 }, uHappy: { value: 0 }, uSleepy: { value: 0 }, uGrin: { value: 0 }, uLook: { value: new THREE.Vector2() },
          uBrow: { value: 0 }, uBrowTilt: { value: 0 }, uBrowAsym: { value: 0 }, uBlush: { value: 0 },
          uSmile: { value: 1 }, uOh: { value: 0 }, uTalk: { value: 0 }, uHmm: { value: 0 }, uFlat: { value: 0 },
          uEye: { value: new THREE.Vector3(0.8, 1, 1) }, uRim: { value: palette[0] },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    const faceGeometry = keep(new THREE.PlaneGeometry(faceSize.x, faceSize.y, 24, 16));
    const corners = faceGeometry.attributes.position;
    for (let i = 0; i < corners.count; i += 1) {
      const x = corners.getX(i);
      const y = corners.getY(i);
      corners.setZ(i, -(0.12 * x * x + 0.16 * y * y));
    }
    faceGeometry.computeVertexNormals();
    const face = new THREE.Mesh(faceGeometry, faceMaterial);
    face.position.set(0, 0.02, HEAD.d / 2 + 0.012);
    face.renderOrder = 2;
    head.add(face);

    const glow = (intensity: number, tint: THREE.Vector3) =>
      keep(
        new THREE.ShaderMaterial({
          vertexShader: GLOW_VERTEX,
          fragmentShader: GLOW_FRAGMENT,
          uniforms: { uColor: { value: tint }, uIntensity: { value: intensity } },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          premultipliedAlpha: true,
        }),
      );

    // Ear pods: they pulse while you talk.
    const earMaterial = glow(0.6, palette[2]);
    const earGeometry = keep(new THREE.CylinderGeometry(0.17, 0.17, 0.09, 32));
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(earGeometry, earMaterial);
      ear.rotation.z = Math.PI / 2;
      ear.position.set(side * (HEAD.w / 2 + 0.035), 0.02, 0);
      ear.renderOrder = 3;
      head.add(ear);
    }

    // Antenna: springs about on its own when the head moves.
    const antenna = new THREE.Group();
    antenna.position.y = HEAD.h / 2 - 0.02;
    head.add(antenna);
    const stalk = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.022, 0.034, 0.34, 12)), glow(0.55, palette[0]));
    stalk.position.y = 0.17;
    stalk.renderOrder = 3;
    antenna.add(stalk);
    const tipMaterial = glow(1, palette[2]);
    const tip = new THREE.Mesh(keep(new THREE.SphereGeometry(0.085, 20, 14)), tipMaterial);
    tip.position.y = 0.37;
    tip.renderOrder = 3;
    antenna.add(tip);
    const haloTexture = keep(radialTexture());
    const tipHalo = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: haloTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
    tipHalo.scale.setScalar(0.56);
    tipHalo.position.y = 0.37;
    tipHalo.renderOrder = 4;
    antenna.add(tipHalo);

    // Orbiting rings: a loading ring when it thinks.
    const ringMaterials: THREE.ShaderMaterial[] = [];
    const rings: THREE.Mesh[] = [];
    for (const [radius, centerY, tiltX, tiltZ, direction] of [[0.62, 1.0, Math.PI / 2 - 0.22, -0.12, -1]] as const) {
      const material = keep(
        new THREE.ShaderMaterial({
          vertexShader: RING_VERTEX,
          fragmentShader: RING_FRAGMENT,
          uniforms: { uTime: time, uSpin: { value: direction }, uAmount: { value: 0.1 }, uColor: { value: palette[2] } },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          premultipliedAlpha: true,
        }),
      );
      const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(radius, 0.012, 6, 180)), material);
      ring.renderOrder = 5;
      const bank = new THREE.Group();
      bank.position.y = centerY;
      bank.rotation.z = tiltZ;
      const tilt = new THREE.Group();
      tilt.rotation.x = tiltX;
      bank.add(tilt);
      tilt.add(ring);
      ringMaterials.push(material);
      rings.push(ring);
      bot.add(bank);
    }

    /* The projector: a pad, a beam of light and rising dust. They stay put. */
    const padMaterial = keep(
      new THREE.ShaderMaterial({
        vertexShader: PAD_VERTEX,
        fragmentShader: PAD_FRAGMENT,
        uniforms: { uTime: time, uLevel: level, uReveal: reveal, uColor: { value: palette[0] }, uAccent: { value: palette[2] } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
      }),
    );
    const pad = new THREE.Mesh(keep(new THREE.CircleGeometry(1.08, 64)), padMaterial);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = -1.58;
    pad.renderOrder = 1;
    scene.add(pad);

    const beamMaterial = keep(
      new THREE.ShaderMaterial({
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        uniforms: { uTime: time, uLevel: level, uReveal: reveal, uColor: { value: palette[0] } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
      }),
    );
    const beam = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.0, 0.72, 0.95, 48, 1, true)), beamMaterial);
    beam.position.y = -1.58 + 0.475;
    beam.renderOrder = 1;
    scene.add(beam);

    const dustCount = 70;
    const seeds = new Float32Array(dustCount * 3);
    for (let i = 0; i < seeds.length; i += 1) seeds[i] = Math.random();
    const dustGeometry = keep(new THREE.BufferGeometry());
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(dustCount * 3), 3));
    dustGeometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 3));
    const dustMaterial = keep(
      new THREE.ShaderMaterial({
        vertexShader: DUST_VERTEX,
        fragmentShader: DUST_FRAGMENT,
        uniforms: { uTime: time, uSpeed: { value: 0.12 }, uScale: { value: pixelRatio() }, uReveal: reveal, uColor: { value: palette[2] } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
      }),
    );
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    dust.frustumCulled = false;
    dust.renderOrder = 2;
    scene.add(dust);

    /* Animation state. */
    const mood: Mood = { ...MOODS.idle };
    const mouth = [...MOUTHS.idle];
    const look = new THREE.Vector2();
    const saccade = new THREE.Vector2();
    let nextSaccade = 1.5;
    let nextBlink = 2 + Math.random() * 2;
    let blink = 0;
    let boopSeen = live.current.boop;
    let boopAge = 9;
    let antennaAngle = 0;
    let antennaVelocity = 0;
    let lastYaw = 0;
    let glitchBurst = 0;
    let flickerHold = 0;
    let revealStarted = -1;
    let slowFrames = 0;
    let lastKey = "idle";
    let hopAge = 9;
    let nod = 0;

    const approach = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-dt * rate));

    const step = (dt: number) => {
      const { state: session, muted: isMuted, outputLevel: readOutput, boop: boopCount } = live.current;
      const key = isMuted && (session === "listening" || session === "hearing") ? "muted" : session;
      const target = MOODS[key] ?? MOODS.idle;
      time.value = (time.value + dt) % 1000;
      const t = time.value;

      // The accent eases towards the state; the body keeps its own colours.
      palette[2].lerp(accents[key] ?? accents.idle, 1 - Math.exp(-dt * 4));
      // A little hop whenever it perks up into a new state.
      if (key !== lastKey) {
        if (key === "listening" || key === "hearing" || key === "speaking") hopAge = 0;
        lastKey = key;
      }
      hopAge += dt;
      for (const name of Object.keys(mood) as Array<keyof Mood>) mood[name] = approach(mood[name], target[name], 5, dt);
      const mouthTarget = MOUTHS[key] ?? MOUTHS.idle;
      for (let i = 0; i < mouth.length; i += 1) mouth[i] = approach(mouth[i], mouthTarget[i], 9, dt);
      muteness.value = approach(muteness.value, key === "muted" || key === "idle" ? (key === "muted" ? 1 : 0.35) : 0, 4, dt);

      // Level: the microphone while you talk, JARVIS's audio while it speaks.
      let raw = 0;
      if (session === "speaking") raw = readOutput();
      else if ((session === "hearing" || session === "listening") && !isMuted) raw = levelRef.current;
      raw = Math.max(0, Math.min(1, raw));
      level.value += (raw - level.value) * (raw > level.value ? 1 - Math.exp(-dt * 20) : 1 - Math.exp(-dt * 6));

      // Blinks and little glances, like it is paying attention.
      nextBlink -= dt;
      if (nextBlink <= 0 && key !== "muted") {
        blink = 1;
        // Now and then a quick double blink.
        nextBlink = Math.random() < 0.25 ? 0.28 : 2.2 + Math.random() * 3.2;
      }
      blink = Math.max(0, blink - dt * 7);
      nextSaccade -= dt;
      if (nextSaccade <= 0) {
        const roam = key === "thinking" ? 0.25 : key === "idle" || key === "listening" ? 0.35 : 0.12;
        saccade.set((Math.random() - 0.5) * roam * 2, (Math.random() - 0.5) * roam);
        nextSaccade = 0.9 + Math.random() * 2.2;
      }
      look.x = approach(look.x, mood.lookX + saccade.x, 14, dt);
      look.y = approach(look.y, mood.lookY + saccade.y, 14, dt);

      // A tap: squash, stretch, grin and glitch.
      if (boopCount !== boopSeen) {
        boopSeen = boopCount;
        boopAge = 0;
        glitchBurst = 0.35;
      }
      boopAge += dt;
      const squash = boopAge < 1.2 ? Math.exp(-boopAge * 5) * Math.sin(boopAge * 22) : 0;
      const grin = boopAge < 1.1 ? 1 - boopAge / 1.1 : 0;
      glitchBurst = Math.max(0, glitchBurst - dt);

      // Hologram flicker: now and then a frame or two drops out.
      flickerHold -= dt;
      if (flickerHold <= 0) {
        const chance = mood.glitch * 0.08 + (glitchBurst > 0 ? 0.3 : 0);
        flicker.value = Math.random() < chance ? 0.55 + Math.random() * 0.3 : 1;
        flickerHold = 0.03 + Math.random() * 0.06;
      }

      // Materialise once, after the screen has bloomed open.
      if (revealStarted < 0) revealStarted = t;
      if (!reduced) reveal.value = Math.min(1, Math.max(0, (t - revealStarted - 0.15) / 0.95));

      const speaking = key === "speaking" ? level.value : 0;
      const hearing = key === "hearing" ? level.value : 0;

      // Body language: a calm float, a hop into a new state, a nod on each
      // loud syllable, and the look direction leading the head.
      const hop = hopAge < 0.42 ? Math.sin((hopAge / 0.42) * Math.PI) : 0;
      nod = approach(nod, speaking * 0.12 + hearing * 0.05, 18, dt);
      bot.position.y = 0.3 + Math.sin(t * 1.3) * 0.045 - mood.droop * 0.4 + hop * 0.12;
      const yaw = Math.sin(t * 0.5) * 0.05 + look.x * 0.26;
      head.rotation.set(
        -look.y * 0.12 + mood.droop + nod,
        yaw,
        mood.tilt + Math.sin(t * 0.7) * 0.02,
      );
      const stretch = hop * 0.06 + speaking * 0.03;
      head.scale.set(1 + squash * 0.12 - stretch * 0.5, 1 - squash * 0.14 + stretch, 1);

      // Antenna: a damped spring kicked by how fast the head turns.
      const yawSpeed = (yaw - lastYaw) / Math.max(dt, 1e-3);
      lastYaw = yaw;
      antennaVelocity += (-antennaAngle * 90 - antennaVelocity * 9 - yawSpeed * 3.5 - squash * 20) * dt;
      antennaAngle += antennaVelocity * dt;
      antenna.rotation.z = antennaAngle;
      tipMaterial.uniforms.uIntensity.value = 0.7 + level.value * 0.9 + 0.15 * Math.sin(t * 3);
      tipHalo.material.opacity = 0.35 + level.value * 0.65;
      tipHalo.material.color.setRGB(palette[2].x, palette[2].y, palette[2].z);
      earMaterial.uniforms.uIntensity.value = 0.35 + hearing * 1.3 + speaking * 0.6 + 0.08 * Math.sin(t * 2.4);

      rings.forEach((ring, index) => {
        ring.rotation.z -= dt * mood.spin * 0.9;
        ringMaterials[index].uniforms.uAmount.value = mood.ring * 0.8 * reveal.value;
      });
      dustMaterial.uniforms.uSpeed.value = 0.1 + mood.spin * 0.05 + level.value * 0.1;

      // Shader inputs.
      shellMaterial.uniforms.uGlow.value = mood.glow;
      shellMaterial.uniforms.uGlitch.value = Math.max(mood.glitch * 0.35, glitchBurst > 0 ? 1 : 0, reveal.value < 1 ? 0.6 : 0);
      const faceUniforms = faceMaterial.uniforms;
      faceUniforms.uOpen.value = mood.open * (1 - blink * 0.95) * (1 + hearing * 0.12);
      // Speaking: happy eyes come and go with the phrasing, not constantly.
      faceUniforms.uHappy.value = Math.min(1, mood.happy * (session === "speaking" ? Math.max(0, Math.sin(t * 0.9)) : 1) + grin);
      faceUniforms.uSleepy.value = mood.sleepy;
      faceUniforms.uGrin.value = grin;
      faceUniforms.uBrow.value = mood.brow + grin * 0.6 + hop * 0.3;
      faceUniforms.uBrowTilt.value = mood.browTilt;
      faceUniforms.uBrowAsym.value = mood.browAsym;
      faceUniforms.uBlush.value = Math.min(1, mood.blush + grin);
      (faceUniforms.uLook.value as THREE.Vector2).copy(look);
      faceUniforms.uSmile.value = mouth[0] + grin;
      faceUniforms.uOh.value = mouth[1] * (1 - grin);
      faceUniforms.uTalk.value = mouth[2] * (1 - grin);
      faceUniforms.uHmm.value = mouth[3] * (1 - grin);
      faceUniforms.uFlat.value = mouth[4] * (1 - grin);
      (faceUniforms.uEye.value as THREE.Vector3).copy(palette[2]).lerp(white, 0.35);
    };

    const render = () => renderer.render(scene, camera);

    let frame = 0;
    let last = performance.now();
    let disposed = false;
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      live.current.onReady?.(true);
    };

    const loop = (now: number) => {
      frame = 0;
      if (disposed) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const started = performance.now();
      step(dt);
      render();
      announce();
      // Long frames for a few seconds running: fewer pixels, never below 55%.
      if (dt > 0.024 || performance.now() - started > 10) slowFrames += 1;
      else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames > 90 && quality > 0.55) {
        quality = Math.max(0.55, quality - 0.15);
        slowFrames = 0;
        renderer.setPixelRatio(pixelRatio());
        renderer.setSize(size, size, false);
        dustMaterial.uniforms.uScale.value = pixelRatio();
      }
      frame = requestAnimationFrame(loop);
    };
    const start = () => {
      if (disposed || frame || document.hidden || reduced) return;
      last = performance.now();
      frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const still = () => {
      step(1);
      render();
      announce();
    };

    const onVisibility = () => (document.hidden ? stop() : reduced ? still() : start());
    const onLost = (event: Event) => {
      event.preventDefault();
      stop();
      announced = false;
      live.current.onReady?.(false);
    };
    const onRedraw = () => still();
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("jarvis-redraw", onRedraw);
    document.addEventListener("visibilitychange", onVisibility);

    // Compile off the main thread's critical path, then start.
    let compiled = false;
    const compiling = renderer
      .compileAsync(scene, camera)
      .catch(() => undefined)
      .then(() => {
        compiled = true;
        if (disposed) return;
        if (reduced) still();
        else start();
      });

    return () => {
      disposed = true;
      stop();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("jarvis-redraw", onRedraw);
      document.removeEventListener("visibilitychange", onVisibility);
      const release = () => {
        for (const item of disposables) item.dispose();
        renderer.dispose();
      };
      if (compiled) release();
      else void compiling.then(release);
    };
  }, [size, levelRef]);

  // Reduced motion draws only when something changes.
  React.useEffect(() => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    canvasRef.current?.dispatchEvent(new Event("jarvis-redraw"));
  }, [state, muted, boop]);

  return <canvas ref={canvasRef} className={className} style={{ width: size, height: size }} aria-hidden="true" />;
}

/** A soft round glow for sprites. */
function radialTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}
