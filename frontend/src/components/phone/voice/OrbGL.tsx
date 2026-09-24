"use client";

import * as React from "react";

import type { VoiceSessionState } from "@/types";

/**
 * The voice orb, drawn by one fragment shader on a single quad.
 *
 * A sphere whose silhouette is pushed around by noise, with an interior swirl
 * of three colours, a bright rim, a specular glint and a soft halo. Everything
 * it reacts to is real: the microphone level while you talk, JARVIS's own
 * playback level while it speaks, and the session state for colour and swirl
 * speed. Muted drains the colour.
 *
 * Cheap on purpose: a small square canvas, capped pixel ratio, adaptive
 * resolution when frames run long, paused whenever the page is hidden, and a
 * single still frame under reduced motion. If WebGL is unavailable or the
 * context is lost, `onReady(false)` lets the caller keep its CSS orb.
 */

const PALETTES: Record<string, [string, string, string]> = {
  idle: ["#7CC7FF", "#B69CFF", "#D4FF3A"],
  connecting: ["#7CC7FF", "#B69CFF", "#5CF2B5"],
  listening: ["#22E3FF", "#6E8BFF", "#D4FF3A"],
  hearing: ["#D4FF3A", "#22E3FF", "#F4FFD6"],
  thinking: ["#B69CFF", "#FF7AC6", "#7CC7FF"],
  speaking: ["#FF7AC6", "#FFB23D", "#D4FF3A"],
  muted: ["#8A8F98", "#B4B9C2", "#5B6068"],
};

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform float uLevel;
uniform float uThink;
uniform float uSpeak;
uniform float uMuted;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

// Simplex noise, Ashima Arts / Stefan Gustavson (MIT).
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(uv);
  float t = uTime;
  float ang = atan(uv.y, uv.x);
  vec2 dir = vec2(cos(ang), sin(ang));

  float base = 0.285 + 0.01 * sin(t * 1.3) + 0.05 * uLevel;
  float amp = 0.012 + 0.07 * uLevel + 0.02 * uThink;
  float n1 = snoise(vec3(dir * (1.1 + 0.6 * uThink), t * (0.45 + 0.55 * uThink)));
  float n2 = snoise(vec3(dir * 2.6 + 4.0, t * 0.9 + 3.0));
  float R = base + amp * n1 + amp * 0.45 * n2;

  float px = 1.5 / uRes.y;
  float inside = 1.0 - smoothstep(R - px, R + px, r);

  vec3 col = vec3(0.0);
  if (inside > 0.0) {
    vec2 p = uv / R;
    float z = sqrt(max(0.0, 1.0 - dot(p, p)));
    vec3 nrm = vec3(p, z);
    float spin = t * (0.18 + 0.9 * uThink);
    float cs = cos(spin);
    float sn = sin(spin);
    vec2 q = mat2(cs, -sn, sn, cs) * p;
    float f = snoise(vec3(q * 1.35, t * 0.22)) + 0.5 * snoise(vec3(q * 2.7 + 7.1, t * 0.35));
    float g = snoise(vec3(q * 1.9 - 3.3, t * 0.28 + 11.0));
    col = mix(uA, uB, smoothstep(-0.6, 0.7, f + q.y * 0.6));
    col = mix(col, uC, smoothstep(0.3, 0.95, g) * 0.7);
    // Inky folds between the colours keep it saturated rather than pastel.
    col *= 0.62 + 0.38 * smoothstep(-0.9, 0.6, f);
    float fres = pow(1.0 - z, 2.2);
    col *= 0.38 + 0.72 * z;
    col += fres * mix(uB, vec3(1.0), 0.12) * (0.55 + 0.45 * uLevel);
    vec3 light = normalize(vec3(-0.45, 0.55, 0.75));
    col += vec3(pow(max(dot(nrm, light), 0.0), 42.0)) * 0.42;
    col += (uLevel * 0.22) * uC * (1.0 - smoothstep(0.0, 0.85, length(p)));
  }

  // The halo fades to nothing well inside the canvas edge, so the square never shows.
  float halo = exp(-max(r - R, 0.0) * (11.0 - 4.0 * uLevel)) * (0.26 + 0.34 * uLevel + 0.1 * uSpeak);
  halo *= 1.0 - smoothstep(0.36, 0.5, r);
  vec3 haloCol = mix(uA, uB, 0.5 + 0.5 * sin(ang + t * 0.3));

  float gray = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(gray) * 0.6, uMuted * 0.85);
  haloCol = mix(haloCol, vec3(dot(haloCol, vec3(0.333))) * 0.5, uMuted * 0.85);

  float haloA = halo * (1.0 - inside);
  gl_FragColor = vec4(col * inside + haloCol * haloA, clamp(inside + haloA, 0.0, 1.0));
}
`;

export interface OrbGLProps {
  state: VoiceSessionState;
  muted: boolean;
  /** Microphone level, updated by the session outside React. */
  levelRef: React.MutableRefObject<number>;
  /** JARVIS's playback level. */
  outputLevel: () => number;
  size: number;
  onReady?: (ready: boolean) => void;
  className?: string;
}

export function OrbGL({ state, muted, levelRef, outputLevel, size, onReady, className }: OrbGLProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const live = React.useRef({ state, muted, outputLevel, onReady });
  live.current = { state, muted, outputLevel, onReady };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let quality = 1;
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let frame = 0;
    let disposed = false;
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const colours = PALETTES.idle.map(rgb);
    const mix = { level: 0, think: 0, speak: 0, muted: 0 };
    let last = performance.now();
    let clockTime = Math.random() * 40;
    let slowFrames = 0;
    // The CSS orb stays up until a frame has actually been drawn.
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      live.current.onReady?.(true);
    };

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2) * quality;
      const pixels = Math.max(64, Math.round(size * ratio));
      if (canvas.width !== pixels) {
        canvas.width = pixels;
        canvas.height = pixels;
      }
      gl?.viewport(0, 0, pixels, pixels);
    };

    const compile = (context: WebGLRenderingContext, type: number, source: string) => {
      const shader = context.createShader(type);
      if (!shader) return null;
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        context.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const init = (): boolean => {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power", depth: false, stencil: false });
      if (!gl) return false;
      const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
      const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      if (!vertex || !fragment) return false;
      program = gl.createProgram();
      if (!program) return false;
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      // One triangle that covers the whole viewport.
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "aPos");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      for (const name of ["uRes", "uTime", "uLevel", "uThink", "uSpeak", "uMuted", "uA", "uB", "uC"]) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      gl.clearColor(0, 0, 0, 0);
      resize();
      return true;
    };

    const draw = (dt: number) => {
      if (!gl || !program) return;
      const { state: current, muted: isMuted, outputLevel: readOutput } = live.current;
      const key = isMuted && (current === "listening" || current === "hearing") ? "muted" : current;
      const target = (PALETTES[key] ?? PALETTES.idle).map(rgb);
      const colourRate = reduced ? 1 : 1 - Math.exp(-dt * 4.5);
      for (let i = 0; i < 3; i += 1) {
        for (let c = 0; c < 3; c += 1) colours[i][c] += (target[i][c] - colours[i][c]) * colourRate;
      }
      let raw = 0;
      if (!reduced) {
        if (current === "speaking") raw = readOutput();
        else if ((current === "hearing" || current === "listening") && !isMuted) raw = levelRef.current;
        else if (current === "thinking") raw = 0.1 + 0.06 * Math.sin(clockTime * 3.2);
      }
      raw = Math.max(0, Math.min(1, raw));
      const attack = raw > mix.level ? 1 - Math.exp(-dt * 18) : 1 - Math.exp(-dt * 5);
      mix.level += (raw - mix.level) * attack;
      const ease = reduced ? 1 : 1 - Math.exp(-dt * 3);
      mix.think += ((current === "thinking" ? 1 : 0) - mix.think) * ease;
      mix.speak += ((current === "speaking" ? 1 : 0) - mix.speak) * ease;
      mix.muted += ((key === "muted" ? 1 : 0) - mix.muted) * ease;

      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uTime, clockTime % 600);
      gl.uniform1f(uniforms.uLevel, mix.level);
      gl.uniform1f(uniforms.uThink, mix.think);
      gl.uniform1f(uniforms.uSpeak, mix.speak);
      gl.uniform1f(uniforms.uMuted, mix.muted);
      gl.uniform3fv(uniforms.uA, colours[0]);
      gl.uniform3fv(uniforms.uB, colours[1]);
      gl.uniform3fv(uniforms.uC, colours[2]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      frame = 0;
      if (disposed) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      clockTime += dt;
      const started = performance.now();
      draw(dt);
      announce();
      // Long frames three seconds running: drop resolution, never below 55%.
      if (dt > 0.024 || performance.now() - started > 12) slowFrames += 1;
      else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames > 90 && quality > 0.55) {
        quality = Math.max(0.55, quality - 0.15);
        slowFrames = 0;
        resize();
      }
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      if (disposed || frame || document.hidden) return;
      last = performance.now();
      frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const onVisibility = () => (document.hidden ? stop() : reduced ? draw(1) : start());
    const onLost = (event: Event) => {
      event.preventDefault();
      stop();
      announced = false;
      live.current.onReady?.(false);
    };
    const onRestored = () => {
      if (!init()) return;
      if (reduced) {
        draw(1);
        announce();
      } else start();
    };

    const onRedraw = () => draw(1);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    canvas.addEventListener("jarvis-redraw", onRedraw);
    document.addEventListener("visibilitychange", onVisibility);

    if (init()) {
      if (reduced) {
        draw(1);
        announce();
      } else start();
    } else {
      live.current.onReady?.(false);
    }

    return () => {
      disposed = true;
      stop();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.removeEventListener("jarvis-redraw", onRedraw);
      document.removeEventListener("visibilitychange", onVisibility);
      // No explicit loseContext(): an effect that runs again on the same
      // canvas (a remount, React's development double-invoke) would get the
      // dead context back and draw nothing. The browser retires the oldest
      // context itself if too many are alive.
    };
  }, [size, levelRef]);

  // Reduced motion draws only when something changes.
  React.useEffect(() => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    canvasRef.current?.dispatchEvent(new Event("jarvis-redraw"));
  }, [state, muted]);

  return <canvas ref={canvasRef} className={className} style={{ width: size, height: size }} aria-hidden="true" />;
}
