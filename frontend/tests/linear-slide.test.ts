/** Deterministic timing checks. No browser, credentials or live data. */
import assert from "node:assert/strict";
import { createLinearSlide, MS_PER_SPACE } from "../src/components/mobile-desk/linearSlide";

function target() {
  const calls: { frames: Keyframe[]; options: KeyframeAnimationOptions; animation: Animation; cancelled: boolean }[] = [];
  const element = {
    style: { transform: "" },
    animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const call = { frames, options, animation: null as unknown as Animation, cancelled: false };
      call.animation = { currentTime: 0, cancel() { call.cancelled = true; } } as Animation;
      calls.push(call);
      return call.animation;
    },
  } as unknown as HTMLElement;
  return { element, calls };
}

const track = target(), dock = target();
const slide = createLinearSlide([{ element: track.element, percent: -100 }, { element: dock.element, percent: 100 }], 1);
assert.equal(track.element.style.transform, "translateX(-100%)");
slide.move(2);
assert.equal(track.calls[0].options.duration, MS_PER_SPACE);
assert.equal(track.calls[0].options.easing, "linear");
assert.equal(dock.calls[0].options.duration, track.calls[0].options.duration);
assert.equal(dock.calls[0].frames[1].transform, "translateX(200%)");
// Interrupt halfway. The new move must start there, not at either endpoint.
track.calls[0].animation.currentTime = MS_PER_SPACE / 2;
slide.move(0);
assert.equal(track.calls[0].cancelled, true);
assert.equal(track.calls[1].frames[0].transform, "translateX(-150%)");
assert.equal(track.calls[1].options.duration, MS_PER_SPACE * 1.5);
assert.equal(dock.calls[1].frames[0].transform, "translateX(150%)");
track.calls[1].animation.currentTime = MS_PER_SPACE * 1.5;
slide.move(2);
assert.equal(track.calls[2].options.duration, MS_PER_SPACE * 2);
slide.move(1, true);
assert.equal(track.calls.length, 3);
assert.equal(track.element.style.transform, "translateX(-100%)");
slide.move(1);
assert.equal(track.calls.length, 3);
slide.dispose();
assert.equal(dock.element.style.transform, "translateX(100%)");
assert.ok(track.calls.every(call => call.cancelled));
console.log("Linear slide: 15 assertions passed (speed, reversal, ordering, reduced motion, cleanup).");
