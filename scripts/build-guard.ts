/**
 * build-guard.ts
 *
 * One assertion, reused by every build script: a pipeline step that silently
 * produces empty/degraded output (rather than failing) is worse than a crash —
 * it ships a server that LOOKS complete (tool calls succeed) but quietly returns
 * nothing useful. Call this instead of `console.warn` whenever a step's output
 * count could legitimately be zero due to a missing/broken upstream dependency.
 */
export function assertBuildStep(ok: boolean, message: string): void {
  if (ok) return;
  throw new Error(`\n\n🚨🚨🚨  BUILD ABORTED  🚨🚨🚨\n\n${message}\n`);
}
