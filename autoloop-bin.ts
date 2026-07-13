import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Resolve the path to the autoloop binary.
 * Priority:
 *   1. PI_AUTOLOOP_BIN env var (explicit override — e.g. local dev checkout)
 *   2. Bundled @mobrienv/autoloop dependency (resolved via its package.json 'bin'
 *      entry, joined to the package root — NOT a hardcoded subpath, which throws
 *      ERR_PACKAGE_PATH_NOT_EXPORTED under the package's "exports" map)
 *   3. Fallback to "autoloop" on $PATH
 */
export function resolveAutoloopBin(): string {
  if (process.env.PI_AUTOLOOP_BIN) return process.env.PI_AUTOLOOP_BIN;
  try {
    const require = createRequire(import.meta.url);
    // ./package.json IS exported, so this resolves cleanly. The package root is its
    // dirname; join the declared bin entry (falling back to bin/autoloop).
    const pkgJsonPath = require.resolve("@mobrienv/autoloop/package.json");
    const pkgRoot = dirname(pkgJsonPath);
    const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
    const binRel =
      typeof pkg.bin === "string"
        ? pkg.bin
        : pkg.bin?.autoloop ?? "bin/autoloop";
    const binPath = join(pkgRoot, binRel);
    if (existsSync(binPath)) return binPath;
  } catch {
    /* fall through to PATH */
  }
  return "autoloop";
}
