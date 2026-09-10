"use client";

import * as React from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import type { VoiceSessionState } from "@/types";

/**
 * The core: a shell of circuit filaments, not a lit sphere.
 *
 * Built from line geometry throughout — traces that walk the surface and turn
 * at right angles, junction dots where they turn, sweeping arcs and radial
 * spokes. A displaced mesh with fresnel shading reads as a soft ball no matter
 * how it is tuned; hairline additive lines against black read as machinery,
 * which is the whole point.
 *
 * Driven entirely through refs, never React state: the loop runs at 60fps and
 * re-rendering the tree per frame (or per microphone sample) would be ruinous.
 */

/** Per-state look. Colour carries the meaning; red means sound is coming out. */
const MOODS: Record<
  VoiceSessionState,
  { color: number; hot: number; speed: number; bloom: number; jitter: number }
> = {
  idle: { color: 0x1466ff, hot: 0x63b3ff, speed: 0.06, bloom: 0.22, jitter: 0.0 },
  connecting: { color: 0x1e8bff, hot: 0x8ed0ff, speed: 0.4, bloom: 0.3, jitter: 0.3 },
  listening: { color: 0x00a6ff, hot: 0x9adcff, speed: 0.12, bloom: 0.32, jitter: 0.05 },
  hearing: { color: 0x22ccff, hot: 0xd2f4ff, speed: 0.3, bloom: 0.42, jitter: 0.5 },
  thinking: { color: 0x4d5cff, hot: 0xa9b4ff, speed: 0.85, bloom: 0.38, jitter: 0.65 },
  speaking: { color: 0xff1f1f, hot: 0xffb4a0, speed: 0.5, bloom: 0.5, jitter: 0.85 },
};

/* Exposure control.
 *
 * ~15k additive line segments overlap heavily near the centre of the
 * projection, so brightness accumulates far past 1.0 and the shell clips to
 * solid white — every filament lost inside a glowing ball. The fix is not less
 * geometry but less light per line: each stays dim, and only where many
 * genuinely overlap does it read as bright. Bloom then has to be restrained
 * too, or it hands the saturation straight back. */
const TRACE_OPACITY = 0.3;
const INNER_OPACITY = 0.16;
const ARC_OPACITY = 0.26;
const SPOKE_OPACITY = 0.24;

/* -------------------------------------------------------------------------- */
/* Geometry generation                                                        */
/* -------------------------------------------------------------------------- */

function randomUnitVector(): THREE.Vector3 {
  // Rejection-free spherical sampling; uniform over the sphere.
  const z = Math.random() * 2 - 1;
  const theta = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return new THREE.Vector3(r * Math.cos(theta), r * Math.sin(theta), z);
}

/**
 * Circuit traces: walks across the sphere that step along a great circle and
 * periodically turn 90° in the tangent plane.
 *
 * The right-angle turns are what make it read as etched circuitry rather than
 * scribble — organic curves would look like a plasma ball.
 */
function buildTraces(count: number, radiusFn: () => number, turnChance = 0.46) {
  const positions: number[] = [];
  const colors: number[] = [];
  const junctions: number[] = [];

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const previous = new THREE.Vector3();
  const scratch = new THREE.Vector3();

  for (let t = 0; t < count; t += 1) {
    point.copy(randomUnitVector());
    tangent.copy(randomUnitVector()).cross(point).normalize();

    const shell = radiusFn();
    // A minority of traces are hot; most are dim. That contrast is what makes
    // the bright ones read as sharp rather than as an even haze.
    const brightness = Math.random() < 0.22 ? 1 : 0.28 + Math.random() * 0.35;
    // Short walks, many of them: density comes from count, not from length.
    const steps = 4 + Math.floor(Math.random() * 10);

    for (let s = 0; s < steps; s += 1) {
      const angle = 0.03 + Math.random() * 0.08;
      previous.copy(point);

      // Great-circle step: rotate the point toward the tangent direction.
      scratch.copy(point).multiplyScalar(Math.cos(angle));
      scratch.addScaledVector(tangent, Math.sin(angle));
      const nextTangent = tangent
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(point, -Math.sin(angle));
      point.copy(scratch).normalize();
      tangent.copy(nextTangent).normalize();

      positions.push(
        previous.x * shell, previous.y * shell, previous.z * shell,
        point.x * shell, point.y * shell, point.z * shell,
      );
      for (let v = 0; v < 2; v += 1) colors.push(brightness, brightness, brightness);

      // Right-angle turn: rotating the tangent about the surface normal.
      if (Math.random() < turnChance) {
        tangent.cross(point).normalize();
        if (Math.random() < 0.5) tangent.negate();
        junctions.push(point.x * shell, point.y * shell, point.z * shell);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    junctions: new Float32Array(junctions),
  };
}

/** Sweeping arcs at assorted radii and tilts — the concentric bands. */
function buildArcs(count: number) {
  const positions: number[] = [];
  const colors: number[] = [];
  const axis = new THREE.Vector3();
  const basisA = new THREE.Vector3();
  const basisB = new THREE.Vector3();
  const current = new THREE.Vector3();
  const previous = new THREE.Vector3();

  for (let a = 0; a < count; a += 1) {
    axis.copy(randomUnitVector());
    basisA.copy(randomUnitVector()).cross(axis).normalize();
    basisB.copy(axis).cross(basisA).normalize();

    // Tighter radius band and shorter sweeps than one might expect: long arcs
    // read as loose loops, short ones read as concentric banding.
    const radius = 0.55 + Math.random() * 0.55;
    const start = Math.random() * Math.PI * 2;
    const sweep = 0.25 + Math.random() * 1.15;
    const segments = Math.max(8, Math.floor(sweep * 26));
    const brightness = Math.random() < 0.3 ? 0.95 : 0.2 + Math.random() * 0.3;

    for (let s = 0; s <= segments; s += 1) {
      const angle = start + (sweep * s) / segments;
      current
        .copy(basisA)
        .multiplyScalar(Math.cos(angle) * radius)
        .addScaledVector(basisB, Math.sin(angle) * radius);
      if (s > 0) {
        positions.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
        for (let v = 0; v < 2; v += 1) colors.push(brightness, brightness, brightness);
      }
      previous.copy(current);
    }
  }

  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}

/**
 * Short stubs standing off the shell, like probes off a board.
 *
 * Deliberately tiny — longer spikes turn the whole thing into a sea urchin,
 * which is the opposite of the dense etched look.
 */
function buildSpokes(count: number) {
  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const direction = randomUnitVector();
    const inner = 0.99 + Math.random() * 0.03;
    const outer = inner + 0.02 + Math.random() * 0.06;
    const brightness = 0.35 + Math.random() * 0.6;
    positions.push(
      direction.x * inner, direction.y * inner, direction.z * inner,
      direction.x * outer, direction.y * outer, direction.z * outer,
    );
    for (let v = 0; v < 2; v += 1) colors.push(brightness, brightness, brightness);
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}

/* -------------------------------------------------------------------------- */

interface JarvisCoreProps {
  state: VoiceSessionState;
  /** Live microphone level, 0..1 — makes the shell answer to your voice. */
  level?: number;
  className?: string;
  /**
   * Move the core aside to make room for a readout.
   *
   * Done by flying the camera rather than by scaling the canvas in CSS, and
   * the difference is visible: this canvas is not transparent in practice.
   * The renderer is created with `alpha: true` and a zero clear alpha, but it
   * draws through an EffectComposer, and the bloom pass composites via a
   * full-screen quad that writes opaque black. While the canvas covered the
   * whole viewport that was invisible — it matched the HUD's own background.
   * Scaling it to 42% turned it into a hard-edged black rectangle sitting on
   * the interface.
   *
   * Moving the camera keeps the canvas exactly where it is, full-bleed, and
   * moves only what is drawn inside it. Which is also what was actually
   * asked for: the background stays fixed and the object moves.
   */
  aside?: boolean;
}

export function JarvisCore({
  state,
  level = 0,
  className,
  aside = false,
}: JarvisCoreProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const asideRef = React.useRef(aside);
  asideRef.current = aside;
  const stateRef = React.useRef<VoiceSessionState>(state);
  const levelRef = React.useRef(0);

  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);
  React.useEffect(() => {
    levelRef.current = level;
  }, [level]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 4.1);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    // Everything hangs off one group so the whole assembly turns together.
    const shell = new THREE.Group();
    scene.add(shell);

    const disposables: Array<{ dispose(): void }> = [];

    const lineMaterial = (opacity: number) => {
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      disposables.push(material);
      return material;
    };

    /* ------------------------------------------------------------- traces */
    // The outer shell: many short walks on a narrow radius band, so it reads as
    // one dense etched surface rather than a fuzzy cloud.
    const traceData = buildTraces(900, () => 1 + (Math.random() - 0.5) * 0.07);
    const traceGeometry = new THREE.BufferGeometry();
    traceGeometry.setAttribute("position", new THREE.BufferAttribute(traceData.positions, 3));
    traceGeometry.setAttribute("color", new THREE.BufferAttribute(traceData.colors, 3));
    const traceMaterial = lineMaterial(TRACE_OPACITY);
    const traces = new THREE.LineSegments(traceGeometry, traceMaterial);
    shell.add(traces);
    disposables.push(traceGeometry);

    /* ------------------------------------------------------ inner cluster */
    // Fills the middle. Without this the shell is a hollow outline and the
    // silhouette reads as an empty bubble.
    const innerData = buildTraces(420, () => 0.18 + Math.random() * 0.5, 0.5);
    const innerGeometry = new THREE.BufferGeometry();
    innerGeometry.setAttribute("position", new THREE.BufferAttribute(innerData.positions, 3));
    innerGeometry.setAttribute("color", new THREE.BufferAttribute(innerData.colors, 3));
    const innerMaterial = lineMaterial(INNER_OPACITY);
    const inner = new THREE.LineSegments(innerGeometry, innerMaterial);
    shell.add(inner);
    disposables.push(innerGeometry);

    /* ---------------------------------------------------------- junctions */
    const junctionGeometry = new THREE.BufferGeometry();
    junctionGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(traceData.junctions, 3),
    );
    const junctionMaterial = new THREE.PointsMaterial({
      size: 0.018,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const junctions = new THREE.Points(junctionGeometry, junctionMaterial);
    shell.add(junctions);
    disposables.push(junctionGeometry, junctionMaterial);

    /* --------------------------------------------------------------- arcs */
    const arcData = buildArcs(200);
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute("position", new THREE.BufferAttribute(arcData.positions, 3));
    arcGeometry.setAttribute("color", new THREE.BufferAttribute(arcData.colors, 3));
    const arcMaterial = lineMaterial(ARC_OPACITY);
    const arcs = new THREE.LineSegments(arcGeometry, arcMaterial);
    shell.add(arcs);
    disposables.push(arcGeometry);

    /* ------------------------------------------------------------- spokes */
    const spokeData = buildSpokes(420);
    const spokeGeometry = new THREE.BufferGeometry();
    spokeGeometry.setAttribute("position", new THREE.BufferAttribute(spokeData.positions, 3));
    spokeGeometry.setAttribute("color", new THREE.BufferAttribute(spokeData.colors, 3));
    const spokeMaterial = lineMaterial(SPOKE_OPACITY);
    const spokes = new THREE.LineSegments(spokeGeometry, spokeMaterial);
    shell.add(spokes);
    disposables.push(spokeGeometry);

    /* --------------------------------------------------------- satellites */
    // Bright points on inclined orbits. Unlike the shell — which turns as one
    // body — these visibly travel, which is what makes the whole assembly read
    // as running rather than merely rotating.
    const SATELLITES = 7;
    const satelliteOrbits = Array.from({ length: SATELLITES }, (_, index) => ({
      radius: 1.5 + Math.random() * 0.9,
      tilt: (index / SATELLITES) * Math.PI,
      phase: Math.random() * Math.PI * 2,
      speed: 0.25 + Math.random() * 0.55,
      squash: 0.55 + Math.random() * 0.45,
    }));
    const satellitePositions = new Float32Array(SATELLITES * 3);
    const satelliteGeometry = new THREE.BufferGeometry();
    satelliteGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(satellitePositions, 3),
    );
    const satelliteMaterial = new THREE.PointsMaterial({
      size: 0.055,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const satellites = new THREE.Points(satelliteGeometry, satelliteMaterial);
    scene.add(satellites);
    disposables.push(satelliteGeometry, satelliteMaterial);

    /* -------------------------------------------------------- scan sweep */
    // A ring that travels down through the sphere and restarts — the single
    // most legible "this thing is working" cue in the whole scene.
    const sweepGeometry = new THREE.TorusGeometry(1, 0.005, 6, 160);
    const sweepMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sweep = new THREE.Mesh(sweepGeometry, sweepMaterial);
    sweep.rotation.x = Math.PI / 2;
    scene.add(sweep);
    disposables.push(sweepGeometry, sweepMaterial);

    /* ----------------------------------------------------------- outer halo */
    const HALO = 700;
    const haloPositions = new Float32Array(HALO * 3);
    for (let i = 0; i < HALO; i += 1) {
      const direction = randomUnitVector();
      const distance = 2.1 + Math.random() * 2.6;
      haloPositions[i * 3] = direction.x * distance;
      haloPositions[i * 3 + 1] = direction.y * distance;
      haloPositions[i * 3 + 2] = direction.z * distance;
    }
    const haloGeometry = new THREE.BufferGeometry();
    haloGeometry.setAttribute("position", new THREE.BufferAttribute(haloPositions, 3));
    const haloMaterial = new THREE.PointsMaterial({
      size: 0.016,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const halo = new THREE.Points(haloGeometry, haloMaterial);
    scene.add(halo);
    disposables.push(haloGeometry, haloMaterial);

    /* ---------------------------------------------------------- hot core */
    // A small hard centre. Without it the shell has no focal point and the eye
    // has nowhere to land.
    const coreGeometry = new THREE.IcosahedronGeometry(0.2, 1);
    const coreMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    scene.add(core);
    disposables.push(coreGeometry, coreMaterial);

    const coreWireGeometry = new THREE.WireframeGeometry(
      new THREE.IcosahedronGeometry(0.34, 1),
    );
    const coreWireMaterial = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const coreWire = new THREE.LineSegments(coreWireGeometry, coreWireMaterial);
    scene.add(coreWire);
    disposables.push(coreWireGeometry, coreWireMaterial);

    /* ------------------------------------------------------------- bloom */
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // Tight radius and a real threshold: a wide, low-threshold bloom is exactly
    // what turns fine lines into a soft glowing ball. Only the hottest traces
    // are allowed to bleed.
    // Threshold well above the per-line brightness, so a single filament never
    // blooms — only places where many cross. That is what keeps the structure
    // legible instead of melting it into a ball.
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), MOODS.idle.bloom, 0.4, 0.62);
    composer.addPass(bloom);

    /* ------------------------------------------------------------ resize */
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloom.setSize(w, h);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    /* --------------------------------------------------------- the loop */
    const startedAt = performance.now();
    let lastFrameAt = startedAt;

    const currentColor = new THREE.Color(MOODS.idle.color);
    const currentHot = new THREE.Color(MOODS.idle.hot);
    const targetColor = new THREE.Color();
    const targetHot = new THREE.Color();
    let bloomStrength = MOODS.idle.bloom;
    let smoothedLevel = 0;
    let spin = 0;
    let frame = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let running = true;

    /**
     * Is this canvas actually producing pixels?
     *
     * `visibilitychange` covers the app being backgrounded, and nothing else.
     * It does not cover the case that was actually costing the most: the voice
     * launcher panel is mounted inside a `hidden lg:block` wrapper, so on a
     * phone it sits under `display: none` for the entire session -- and
     * `display: none` stops painting, not `requestAnimationFrame`. This scene
     * is ~15k additive line segments through an UnrealBloomPass; it was
     * running sixty times a second, on the same GPU driving the interface,
     * producing zero visible pixels.
     *
     * `offsetParent` is null exactly when the element or an ancestor is
     * `display: none`, which is the cheapest correct test available. The size
     * check catches a container collapsed to nothing.
     */
    const painted = () =>
      host.offsetParent !== null && host.clientWidth > 0 && host.clientHeight > 0;

    const render = (now: number) => {
      if (!running) return;

      if (!painted()) {
        // Idle instead of spinning. Four checks a second is free next to a
        // bloom pass, and it resumes the moment the element is shown again --
        // no observer to wire up, and no way for it to miss a wake-up.
        idleTimer = setTimeout(() => {
          idleTimer = null;
          lastFrameAt = performance.now();
          frame = requestAnimationFrame(render);
        }, 250);
        return;
      }

      frame = requestAnimationFrame(render);

      const elapsed = (now - startedAt) / 1000;
      const delta = Math.min((now - lastFrameAt) / 1000, 0.05);
      lastFrameAt = now;

      // Fly the camera rather than cut it. Framerate-independent smoothing, so
      // the move takes the same time on a phone as on a desktop.
      const wide = host.clientWidth >= 1024;
      const parked = asideRef.current;
      const goalZ = parked ? 7.4 : 4.1;
      // Lower the camera and the core rises in frame; slide it right and the
      // core moves left. No `lookAt`, so the framing shifts instead of
      // re-centring on the subject.
      const goalY = parked && !wide ? -1.35 : 0;
      const goalX = parked && wide ? 1.9 : 0;
      const glide = Math.min(1, delta * 5.2);
      camera.position.x += (goalX - camera.position.x) * glide;
      camera.position.y += (goalY - camera.position.y) * glide;
      camera.position.z += (goalZ - camera.position.z) * glide;
      const mood = MOODS[stateRef.current] ?? MOODS.idle;

      targetColor.setHex(mood.color);
      targetHot.setHex(mood.hot);
      // Ease, so the blue-to-red change reads as a transition rather than a cut.
      const ease = 1 - Math.pow(0.0015, delta);
      currentColor.lerp(targetColor, ease);
      currentHot.lerp(targetHot, ease);
      bloomStrength += (mood.bloom - bloomStrength) * (1 - Math.pow(0.01, delta));

      // Fast attack, slow release: jumps on a syllable, no flicker between words.
      const raw = levelRef.current;
      smoothedLevel += (raw - smoothedLevel) * (raw > smoothedLevel ? 0.4 : 0.06);

      traceMaterial.color.copy(currentColor);
      innerMaterial.color.copy(currentHot);
      arcMaterial.color.copy(currentColor);
      spokeMaterial.color.copy(currentColor);
      junctionMaterial.color.copy(currentHot);
      coreMaterial.color.copy(currentHot);
      coreWireMaterial.color.copy(currentHot);
      satelliteMaterial.color.copy(currentHot);
      sweepMaterial.color.copy(currentHot);
      haloMaterial.color.copy(currentColor);

      // The web brightens and the junctions swell with the voice.
      traceMaterial.opacity = TRACE_OPACITY * (1 + smoothedLevel * 0.5);
      innerMaterial.opacity = INNER_OPACITY * (1 + smoothedLevel * 0.6);
      arcMaterial.opacity = ARC_OPACITY * (1 + smoothedLevel * 0.5);
      spokeMaterial.opacity = SPOKE_OPACITY * (1 + smoothedLevel * 0.6);
      junctionMaterial.size = 0.018 + smoothedLevel * 0.018;
      bloom.strength = bloomStrength + smoothedLevel * 0.18;

      spin += delta * mood.speed;
      shell.rotation.y = spin;
      shell.rotation.x = Math.sin(spin * 0.4) * 0.22;
      // A shell that breathes very slightly, plus a kick from the voice.
      const scale = 1 + Math.sin(elapsed * 0.7) * 0.012 + smoothedLevel * 0.05;
      shell.scale.setScalar(scale);

      // The arcs and the inner cluster counter-rotate, so the assembly never
      // looks like one rigid body being spun.
      arcs.rotation.z = -spin * 0.6;
      arcs.rotation.x = spin * 0.25;
      inner.rotation.y = -spin * 1.4;
      inner.rotation.z = spin * 0.5;

      // The core spins hard and flickers with activity — the eye reads it as
      // the thing doing the work.
      coreWire.rotation.y = -elapsed * (0.6 + mood.jitter * 2.2);
      coreWire.rotation.z = elapsed * 0.4;
      const pulse = 1 + Math.sin(elapsed * 6) * 0.06 * mood.jitter + smoothedLevel * 0.35;
      core.scale.setScalar(pulse);
      coreWire.scale.setScalar(pulse);

      // Satellites travel their own orbits, independent of the shell's spin.
      for (let i = 0; i < SATELLITES; i += 1) {
        const orbit = satelliteOrbits[i];
        const angle = orbit.phase + elapsed * orbit.speed * (0.6 + mood.speed);
        const x = Math.cos(angle) * orbit.radius;
        const y = Math.sin(angle) * orbit.radius * orbit.squash;
        // Tilt the orbital plane so they do not all share one ring.
        satellitePositions[i * 3] = x;
        satellitePositions[i * 3 + 1] = y * Math.cos(orbit.tilt);
        satellitePositions[i * 3 + 2] = y * Math.sin(orbit.tilt);
      }
      satelliteGeometry.attributes.position.needsUpdate = true;
      satelliteMaterial.size = 0.06 + smoothedLevel * 0.05;

      // Scan sweep: travels top to bottom, then restarts. The ring narrows
      // toward the poles so it looks like a plane cutting through a sphere.
      const sweepCycle = (elapsed * (0.28 + mood.speed * 0.35)) % 1;
      const height = 1.25 - sweepCycle * 2.5;
      sweep.position.y = height;
      const chord = Math.sqrt(Math.max(0, 1 - Math.min(1, (height / 1.25) ** 2)));
      sweep.scale.setScalar(Math.max(0.02, chord * 1.18));
      sweepMaterial.opacity = 0.12 + chord * 0.28;

      halo.rotation.y = -spin * 0.15;
      halo.rotation.x = spin * 0.05;
      haloMaterial.opacity = 0.18 + smoothedLevel * 0.18;

      composer.render();
    };

    if (reduceMotion) {
      traceMaterial.color.copy(currentColor);
      innerMaterial.color.copy(currentHot);
      arcMaterial.color.copy(currentColor);
      spokeMaterial.color.copy(currentColor);
      junctionMaterial.color.copy(currentHot);
      coreMaterial.color.copy(currentHot);
      coreWireMaterial.color.copy(currentHot);
      satelliteMaterial.color.copy(currentHot);
      sweepMaterial.color.copy(currentHot);
      haloMaterial.color.copy(currentColor);
      composer.render();
    } else {
      frame = requestAnimationFrame(render);
    }

    const onVisibility = () => {
      if (reduceMotion) return;
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      } else if (!running) {
        running = true;
        lastFrameAt = performance.now();
        frame = requestAnimationFrame(render);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      if (idleTimer) clearTimeout(idleTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      for (const item of disposables) item.dispose();
      composer.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} className={className} aria-hidden />;
}
