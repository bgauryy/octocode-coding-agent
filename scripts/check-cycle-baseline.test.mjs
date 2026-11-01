import assert from "node:assert/strict";
import test from "node:test";

import { findCycleBaseline, staleCycleEntries } from "./check-cycle-baseline.mjs";

test("findCycleBaseline picks the named-file override that only sets import/no-cycle", () => {
	const named = { files: ["packages/a/src/x.ts"], rules: { "import/no-cycle": "error" } };
	const config = {
		overrides: [
			{ files: ["packages/a/src/**"], rules: { "import/no-cycle": "off" } },
			{ files: ["packages/a/src/y.ts"], rules: { "max-lines": "off" } },
			named,
		],
	};
	assert.equal(findCycleBaseline(config), named);
	assert.equal(findCycleBaseline({ overrides: [] }), undefined);
});

test("staleCycleEntries lists baseline files that left their cycle or are gone", () => {
	const exists = (file) => !file.endsWith("gone.ts");
	const baseline = ["packages/a/src/in.ts", "packages/a/src/out.ts", "packages/a/src/gone.ts"];
	assert.deepEqual(staleCycleEntries(baseline, ["packages/a/src/in.ts", "packages/a/src/gone.ts"], exists), [
		"packages/a/src/out.ts",
		"packages/a/src/gone.ts",
	]);
});
