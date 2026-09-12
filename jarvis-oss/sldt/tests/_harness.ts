/** Minimal shared test harness -- matches the style already used by frontend/tests/*.test.ts (no framework, run via `npx tsx`). */

let passed = 0;
let failed = 0;

export function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

export async function checkThrows(
  label: string,
  fn: () => Promise<unknown>,
  matches?: (error: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    check(label, false, "expected a throw, none occurred");
  } catch (error) {
    check(label, matches ? matches(error) : true, matches ? `unexpected error: ${error}` : undefined);
  }
}

export function summarize(fileLabel: string): void {
  console.log(`${fileLabel}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
