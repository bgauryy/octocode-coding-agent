import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkSdkReachability, sdkReachEdges, valueImports, SDK_REACH_BASELINE } from "./sdk-reachability.mjs";

const packageNames = new Map([
	["@app/tui", "tui"],
	["@app/webview", "webview"],
	["@app/ai", "ai"],
]);
const options = { entries: ["host/src/core/sdk.ts"], prefix: "host/src/modes/" };
const files = new Map([
	["host/src/core/sdk.ts", ["./session.ts", "@app/ai", "../octocode/loader.ts"]],
	["host/src/core/session.ts", ["./export.ts", "@app/tui/component"]],
	["host/src/core/export.ts", ["@app/webview", "../modes/view.ts"]],
	["host/src/octocode/loader.ts", []],
	["host/src/modes/view.ts", ["@app/tui"]],
	["host/src/unreached.ts", ["@app/tui"]],
]);

test("reports interactive layers reached through value imports and stops at them", () => {
	assert.deepEqual(sdkReachEdges(files, packageNames, options), [
		"host/src/core/export.ts -> host/src/modes/view.ts",
		"host/src/core/export.ts -> webview",
		"host/src/core/session.ts -> tui",
	]);
});

test("a new edge fails and a baseline edge that is gone fails until removed", () => {
	const baseline = [
		"host/src/core/export.ts -> host/src/modes/view.ts",
		"host/src/core/export.ts -> webview",
		"host/src/core/session.ts -> tui",
	];
	assert.deepEqual(checkSdkReachability(files, packageNames, baseline, options), []);
	assert.deepEqual(checkSdkReachability(files, packageNames, baseline.slice(0, 2), options), [
		"sdk-reachability: host/src/core/session.ts -> tui (SDK entry newly reaches it; not in its baseline)",
	]);
	assert.deepEqual(checkSdkReachability(files, packageNames, [...baseline, "host/src/core/old.ts -> tui"], options), [
		"sdk-reachability: host/src/core/old.ts -> tui is no longer reached (remove it from its baseline)",
	]);
	assert.deepEqual(
		checkSdkReachability(files, packageNames, baseline, { ...options, entries: ["host/src/missing.ts"] }).slice(0, 1),
		["sdk-reachability: entry host/src/missing.ts does not exist"],
	);
});

test("a file newly reached through a cut-free import is reported with its own edge", () => {
	const grown = new Map(files).set("host/src/octocode/loader.ts", ["@app/tui"]);
	assert.ok(sdkReachEdges(grown, packageNames, options).includes("host/src/octocode/loader.ts -> tui"));
});

test("only eager value imports count: type imports and dynamic imports do not", () => {
	const source = [
		'import type { A } from "./type-only.ts";',
		'import { type B } from "./inline-type.ts";',
		'import { c } from "./value.ts";',
		'export type { D } from "./type-reexport.ts";',
		'export * from "./star.ts";',
		'export { e } from "./named.ts";',
		'const lazy = () => import("./lazy.ts");',
	].join("\n");
	assert.deepEqual(valueImports(source, "x.ts"), ["./inline-type.ts", "./value.ts", "./star.ts", "./named.ts"]);
});

test("the committed SDK baseline is sorted and names existing importers", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
	assert.deepEqual([...SDK_REACH_BASELINE].sort(), SDK_REACH_BASELINE);
	for (const edge of SDK_REACH_BASELINE) {
		const [importer, target] = edge.split(" -> ");
		assert.ok(existsSync(join(root, "packages", importer)), `${importer} no longer exists`);
		assert.ok(["tui", "webview"].includes(target) || existsSync(join(root, "packages", target)), `${target} is gone`);
	}
});
