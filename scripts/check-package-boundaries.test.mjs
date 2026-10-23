import assert from "node:assert/strict";
import test from "node:test";
import { checkPackageBoundaries } from "./check-package-boundaries.mjs";
const packages = {
	contacts: { name: "@app/contacts" },
	webview: { name: "@app/webview", dependencies: { "@app/contacts": "1" } },
	agent: { name: "@app/agent" },
};
const policy = { contacts: [], webview: ["contacts"], agent: [] };
test("accepts declared inward imports and type imports", () => {
	assert.deepEqual(
		checkPackageBoundaries(
			packages,
			[{ package: "webview", path: "src/view.ts", imports: ["@app/contacts/events"] }],
			policy,
		),
		[],
	);
});
test("rejects outward and undeclared imports even when type-only", () => {
	const issues = checkPackageBoundaries(
		packages,
		[{ package: "contacts", path: "src/types.ts", imports: ["@app/webview"] }],
		policy,
	);
	assert.ok(issues.some((x) => x.includes("forbidden")));
	assert.ok(issues.some((x) => x.includes("undeclared")));
});
test("rejects relative package crossing and unclassified packages", () => {
	const issues = checkPackageBoundaries(
		{ ...packages, rogue: { name: "@app/rogue" } },
		[{ package: "webview", path: "src/view.ts", imports: ["../../agent/src/index.ts"] }],
		policy,
	);
	assert.ok(issues.some((x) => x.includes("relative")));
	assert.ok(issues.some((x) => x.includes("rogue")));
});
test("rejects declared package cycles", () => {
	const p = {
		a: { name: "@app/a", dependencies: { "@app/b": "1" } },
		b: { name: "@app/b", dependencies: { "@app/a": "1" } },
	};
	assert.ok(checkPackageBoundaries(p, [], { a: ["b"], b: ["a"] }).some((x) => x.includes("cycle")));
});
