import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The Node compile cache every CLI process a test starts shares (`NODE_COMPILE_CACHE`, read by `src/cli.ts`). It sits
 * beside the per-run temporary directory (`vitest.tmp.global.ts` makes a fresh one per run), so later runs start warm.
 * A process compiles what the cache lacks and writes it at exit, before it can die: about 5,700 entries for a cold
 * start from source, which kept an ACP agent and its worker alive for seconds after their own shutdown under load.
 */
export function testCompileCacheDir(): string {
	return join(dirname(tmpdir()), "octocode-test-compile-cache");
}

/** The compile-cache entry for a child environment built from scratch (one that does not inherit `process.env`). */
export function compileCacheEnv(): { NODE_COMPILE_CACHE?: string } {
	const dir = process.env.NODE_COMPILE_CACHE;
	return dir ? { NODE_COMPILE_CACHE: dir } : {};
}
