"use client";

import * as React from "react";

import { fxActivity, fxScene, onFx, onFxScene, type FxEvent, type FxKind, type FxScene } from "./fxBus";

export type FxMode = "vivid" | "wild" | "calm" | "off";

/**
 * The living background: one small WebGL canvas behind every screen.
 *
 * A slow domain-warped colour flow in the current tab's palette, with
 * ripples, blooms and sweeps triggered by what happens in the app (see
 * `fxBus`). It renders at about half the CSS resolution (soft gradients do
 * not need more) and lets the compositor scale it up, so its cost does not
 * grow with the phone's pixel density. It idles at 60 fps, runs at full rate
 * only while something is reacting, and stops when hidden or covered.
 */

const PALETTES: Record<FxScene, string[]> = {
  today: ["#D4FF3A", "#7CC7FF", "#B69CFF", "#5CF2B5"],
  tasks: ["#FF9A3D", "#FF7AC6", "#FFC53D", "#FF6B6B"],
  plan: ["#7CC7FF", "#B69CFF", "#5CF2B5", "#6E8BFF"],
  memory: ["#B69CFF", "#FF7AC6", "#7CC7FF", "#FFB23D"],
};

/** How loud each kind of event is, and in which colour it answers. */
const REACTION: Record<FxKind, { strength: number; energy: number; color: string | number }> = {
  tap: { strength: 0.45, energy: 0.1, color: 0 },
  select: { strength: 0.28, energy: 0.05, color: 1 },
  heavy: { strength: 0.75, energy: 0.3, color: 2 },
  success: { strength: 1, energy: 0.6, color: "#D4FF3A" },
  warning: { strength: 0.95, energy: 0.45, color: "#FF4D5E" },
  "toggle-on": { strength: 0.5, energy: 0.15, color: "#D4FF3A" },
  "toggle-off": { strength: 0.35, energy: 0.08, color: "#9A96B8" },
  gesture: { strength: 0.6, energy: 0.2, color: "#FF7AC6" },
  open: { strength: 0.55, energy: 0.18, color: 1 },
  close: { strength: 0.3, energy: 0.06, color: 2 },
  tab: { strength: 0, energy: 0.28, color: 0 },
};

const MODE_VALUE: Record<Exclude<FxMode, "off">, number> = { calm: 0, vivid: 1, wild: 2 };
const RIPPLES = 8;

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
uniform float uEnergy;
uniform float uMode;
uniform float uLight;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uRip[${RIPPLES}];
uniform vec3 uRipC[${RIPPLES}];
uniform vec4 uSweep;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float wild = step(1.5, uMode);
  float calm = 1.0 - step(0.5, uMode);
  float speed = (0.03 + 0.02 * uMode) * (1.0 + uEnergy * 1.6);
  float t = uTime * speed;

  vec2 disp = vec2(0.0);
  vec3 glow = vec3(0.0);
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = uRip[i];
    if (r.w <= 0.001) continue;
    vec2 d = p - vec2(r.x * aspect, r.y);
    float dist = length(d);
    float radius = r.z * (0.5 + 0.45 * r.w) * (1.0 + 0.4 * wild);
    float ring = exp(-pow((dist - radius) * (9.0 - 3.0 * wild), 2.0));
    float life = exp(-r.z * (1.5 - 0.4 * wild)) * r.w;
    disp += (d / (dist + 0.0001)) * ring * life * (0.05 + 0.05 * wild);
    float core = exp(-dist * dist * 9.0) * exp(-r.z * 2.4) * r.w;
    glow += uRipC[i] * (ring * life * 0.9 + core * 0.75);
  }

  vec2 q = p + disp;
  vec2 w = vec2(fbm(q * 1.35 + vec2(t, -t * 0.7)), fbm(q * 1.35 + vec2(-t * 0.8, t) + 5.2));
  float f = fbm(q * 1.15 + w * 1.7 + t * 0.5);
  float g = fbm(q * 2.0 - w * 1.2 - t * 0.35 + 3.0);
  vec3 col = mix(uC0, uC1, smoothstep(0.3, 0.72, f));
  col = mix(col, uC2, smoothstep(0.45, 0.85, g));
  col = mix(col, uC3, smoothstep(0.55, 0.95, w.x) * 0.55);

  float field = smoothstep(0.32, 0.88, f + 0.18 * g);
  float top = 0.35 + 0.65 * smoothstep(0.05, 1.0, uv.y);
  float sweep = 0.0;
  if (uSweep.z > 0.0) {
    float x = uSweep.x > 0.0 ? uv.x : 1.0 - uv.x;
    float front = uSweep.y * 1.5 - 0.25;
    sweep = exp(-pow((x - front) * 5.0, 2.0)) * uSweep.z;
  }
  float intensity = mix(mix(0.3, 0.14, calm), 0.46, wild) * (0.8 + 0.6 * uEnergy);
  float glowGain = mix(mix(0.7, 0.4, calm), 1.05, wild);

  vec3 light = col * field * top * intensity + col * sweep * (0.28 + 0.2 * wild) + glow * glowGain;
  if (wild > 0.5) {
    vec2 cell = floor(q * 34.0);
    float h = hash(cell);
    float twinkle = step(0.982, h) * (0.5 + 0.5 * sin(uTime * (1.5 + h * 4.0) + h * 40.0));
    vec2 fc = fract(q * 34.0) - 0.5;
    light += mix(col, vec3(1.0), 0.4) * twinkle * exp(-dot(fc, fc) * 45.0) * (0.7 + uEnergy);
  }

  vec3 outc;
  if (uLight < 0.5) {
    vec3 base = vec3(0.035, 0.035, 0.045);
    float vignette = 1.0 - 0.3 * pow(length(uv - vec2(0.5, 0.55)) * 1.25, 2.0);
    outc = (base + light) * vignette;
  } else {
    vec3 base = vec3(0.949, 0.941, 0.918);
    float amount = clamp(field * top * intensity * 1.5 + sweep * 0.3 + length(glow) * 0.55, 0.0, 0.75);
    outc = mix(base, mix(base, col, 0.62) + glow * 0.12, amount);
  }
  // Dither so slow gradients never band.
  outc += (hash(gl_FragCoord.xy + fract(uTime * 7.0)) - 0.5) / 255.0 * 1.5;
  gl_FragColor = vec4(outc, 1.0);
}
`;

export function LiveBackground({ mode, light, paused }: { mode: FxMode; light: boolean; paused: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const settings = React.useRef({ mode, light, paused });
  settings.current = { mode, light, paused };
  const wake = React.useRef<() => void>(() => undefined);

  React.useEffect(() => {
    wake.current();
  }, [mode, light, paused]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power", preserveDrawingBuffer: false });
    if (!gl) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    // Asking for the link status blocks until the GPU process has compiled
    // the shader, which can take a noticeable moment on a phone. With
    // KHR_parallel_shader_compile it is polled instead, and the background
    // fades in once ready rather than holding up the first screen.
    const parallel = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
    let disposed = false;
    const whenLinked = (ready: () => void) => {
      if (disposed) return;
      if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) {
        window.setTimeout(() => whenLinked(ready), 16);
        return;
      }
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) ready();
    };

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const at = (name: string) => gl.getUniformLocation(program, name);
    type Uniform = WebGLUniformLocation | null;
    let u: { res: Uniform; time: Uniform; energy: Uniform; mode: Uniform; light: Uniform; c: Uniform[]; rip: Uniform; ripC: Uniform; sweep: Uniform } | null = null;

    // State the frame loop animates.
    const palette = PALETTES[fxScene()].map(rgb);
    let target = PALETTES[fxScene()].map(rgb);
    const ripples = Array.from({ length: RIPPLES }, () => ({ x: 0, y: 0, age: 0, strength: 0, color: [0, 0, 0] as number[] }));
    const ripData = new Float32Array(RIPPLES * 4);
    const ripColors = new Float32Array(RIPPLES * 3);
    const sweep = { direction: 1, progress: 1, strength: 0 };
    let energy = 0;
    let time = Math.random() * 100;
    let last = performance.now();
    let lastDraw = 0;
    let frame = 0;
    let modeValue = 1;

    const resize = () => {
      const scale = settings.current.mode === "wild" ? 0.62 : 0.5;
      const width = Math.max(64, Math.round(canvas.clientWidth * scale));
      const height = Math.max(64, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const colorFor = (value: string | number) => (typeof value === "number" ? palette[value].map((c) => Math.min(1, c * 1.05)) : rgb(value));

    const quiet = () => settings.current.paused || settings.current.mode === "off" || document.hidden;
    const clear = () => {
      for (const ripple of ripples) ripple.strength = 0;
      sweep.strength = 0;
      energy = 0;
    };

    const react = (event: FxEvent) => {
      // Nothing queues up behind voice mode or a switched-off background.
      if (quiet()) return;
      const reaction = REACTION[event.kind];
      energy = Math.min(1, energy + reaction.energy);
      if (event.kind === "tab") {
        sweep.direction = event.direction ?? 1;
        sweep.progress = 0;
        sweep.strength = 1;
      } else if (reaction.strength > 0) {
        // Replace the oldest ripple.
        let slot = ripples[0];
        for (const ripple of ripples) if (ripple.strength <= 0 || ripple.age > slot.age) slot = ripple;
        slot.x = event.x;
        slot.y = 1 - event.y;
        slot.age = 0;
        slot.strength = reaction.strength;
        slot.color = colorFor(reaction.color);
      }
      start();
    };

    const draw = (now: number) => {
      const uniforms = u;
      if (!uniforms) return false;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { mode: currentMode, light: isLight } = settings.current;
      modeValue += ((currentMode === "off" ? 1 : MODE_VALUE[currentMode]) - modeValue) * Math.min(1, dt * 3);
      time += dt;
      energy = Math.max(fxActivity() * 0.6, energy * Math.exp(-dt * 1.1));
      const blend = 1 - Math.exp(-dt * 3.5);
      for (let i = 0; i < 4; i += 1) for (let c = 0; c < 3; c += 1) palette[i][c] += (target[i][c] - palette[i][c]) * blend;
      let live = 0;
      ripples.forEach((ripple, index) => {
        if (ripple.strength > 0) {
          ripple.age += dt;
          if (ripple.age > 3.2) ripple.strength = 0;
          else live += 1;
        }
        ripData.set([ripple.x, ripple.y, ripple.age, ripple.strength], index * 4);
        ripColors.set(ripple.color, index * 3);
      });
      if (sweep.strength > 0) {
        sweep.progress += dt / 0.9;
        sweep.strength = Math.max(0, 1 - sweep.progress);
      }
      resize();
      gl.uniform2f(uniforms.res, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, time);
      gl.uniform1f(uniforms.energy, energy);
      gl.uniform1f(uniforms.mode, modeValue);
      gl.uniform1f(uniforms.light, isLight ? 1 : 0);
      palette.forEach((colour, index) => gl.uniform3fv(uniforms.c[index], colour));
      gl.uniform4fv(uniforms.rip, ripData);
      gl.uniform3fv(uniforms.ripC, ripColors);
      gl.uniform4f(uniforms.sweep, sweep.direction, sweep.progress, sweep.strength, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return live > 0 || sweep.strength > 0 || energy > 0.04;
    };

    const loop = (now: number) => {
      frame = 0;
      if (quiet()) {
        clear();
        return;
      }
      // Busy (reacting): every frame. Calm: about 60 fps, which is plenty for
      // a slow drift and halves the work on a 120 Hz screen.
      const busy = energy > 0.04 || sweep.strength > 0 || ripples.some((ripple) => ripple.strength > 0);
      if (busy || now - lastDraw > 15.5) {
        lastDraw = now;
        draw(now);
      }
      frame = requestAnimationFrame(loop);
    };

    function start() {
      if (frame || reduced.matches || !u) return;
      if (quiet()) {
        clear();
        return;
      }
      last = performance.now();
      frame = requestAnimationFrame(loop);
    }
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const still = () => {
      // Reduced motion: one frame, redrawn only when something changes.
      if (settings.current.mode === "off" || !u) return;
      draw(performance.now());
    };

    wake.current = () => {
      if (reduced.matches) still();
      else start();
    };
    const offFx = onFx((event) => {
      if (!reduced.matches) react(event);
    });
    const offScene = onFxScene((next) => {
      target = PALETTES[next].map(rgb);
      if (reduced.matches) {
        for (let i = 0; i < 4; i += 1) palette[i] = [...target[i]];
        still();
      } else start();
    });
    const onVisibility = () => (document.hidden ? stop() : wake.current());
    const onResize = () => (reduced.matches ? still() : start());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    const onReducedChange = () => wake.current();
    reduced.addEventListener("change", onReducedChange);

    whenLinked(() => {
      gl.useProgram(program);
      u = {
        res: at("uRes"), time: at("uTime"), energy: at("uEnergy"), mode: at("uMode"), light: at("uLight"),
        c: [at("uC0"), at("uC1"), at("uC2"), at("uC3")], rip: at("uRip"), ripC: at("uRipC"), sweep: at("uSweep"),
      };
      canvas.dataset.ready = "true";
      wake.current();
    });

    return () => {
      disposed = true;
      stop();
      offFx();
      offScene();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      reduced.removeEventListener("change", onReducedChange);
      wake.current = () => undefined;
    };
  }, []);

  return <canvas ref={canvasRef} className="ph-live-bg" data-mode={mode} aria-hidden="true" />;
}
