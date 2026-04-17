import { createRequire } from "node:module";

/**
 * Resolve the path to the autoloop binary.
 * Priority:
 *   1. PI_AUTOLOOP_BIN env var (explicit override — e.g. local dev checkout)
 *   2. Bundled @mobrienv/autoloop dependency
 *   3. Fallback to "autoloop" on $PATH
 */
export function resolveAutoloopBin(): string {
  if (process.env.PI_AUTOLOOP_BIN) return process.env.PI_AUTOLOOP_BIN;
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@mobrienv/autoloop/bin/autoloop");
  } catch {
    return "autoloop";
  }
}
