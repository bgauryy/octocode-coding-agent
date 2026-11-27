import { defineConfig, mergeConfig } from "vitest/config";
import hostConfig from "./vitest.config.ts";

/**
 * The default suite with coverage of the session layer (`src/core`): sessions, settings, compaction and the
 * application service. Run with `--coverage`; the Octocode feature layer has its own floor in `vitest.octocode.config.ts`.
 */
export default mergeConfig(
	hostConfig,
	defineConfig({
		test: {
			coverage: {
				provider: "v8",
				include: ["src/core/**/*.ts"],
				// A floor against regressions, set a little below the measured 88.1 / 80.8 / 89.2 / 89.7 (2026-11-11).
				thresholds: { statements: 87, branches: 79, functions: 88, lines: 88 },
			},
		},
	}),
);
