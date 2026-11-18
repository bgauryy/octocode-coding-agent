import { configDefaults } from "vitest/config";

/**
 * Paid tests (real provider or model requests) live in `*.live.test.ts`. Every vitest config leaves them out of its
 * default run, whatever credentials the shell exports; each package's `test:live` script sets this variable and
 * selects them by file name.
 */
const LIVE_TEST_GLOB = "**/*.live.test.{ts,tsx}";
export const LIVE_TESTS_ENV = "OCTOCODE_LIVE_TESTS";

/** `test.exclude` for a config: the vitest defaults, plus the live tests unless this run opted in. */
export function excludeLiveTests(...extra: string[]): string[] {
	return process.env[LIVE_TESTS_ENV] === "1"
		? [...configDefaults.exclude, ...extra]
		: [...configDefaults.exclude, ...extra, LIVE_TEST_GLOB];
}
