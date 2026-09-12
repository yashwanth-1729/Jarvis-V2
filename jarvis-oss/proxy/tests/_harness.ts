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

export function summarize(fileLabel: string): void {
  console.log(`${fileLabel}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
