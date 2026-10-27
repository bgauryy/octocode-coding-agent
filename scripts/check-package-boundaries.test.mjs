import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPackageBoundaries, scanPackageBoundaries } from "./check-package-boundaries.mjs";
import { HOST_IMPORT_BASELINE } from "./host-import-baseline.mjs";
import { LAYER_RULES } from "./layer-import-baseline.mjs";
import { sourceWorkspaceGroups } from "./source-workspaces.mjs";
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

const privatePackages = {
	host: { name: "@app/host", devDependencies: { "@app/mcp": "workspace:*" } },
	mcp: { name: "@app/mcp", private: true, octocodeSource: { host: "host", mount: "mcp" } },
};

test("accepts private implementation imports within the same host compilation", () => {
	assert.deepEqual(
		checkPackageBoundaries(
			privatePackages,
			[
				{ package: "host", path: "src/index.ts", imports: ["../../mcp/src/index.ts"] },
				{ package: "mcp", path: "src/index.ts", imports: ["../../host/src/config.ts"] },
			],
			{ host: [], mcp: [] },
			{ mcp: ["host/src/config.ts"] },
		),
		[],
	);
});

test("a hosted workspace cannot reach host files outside its baseline", () => {
	const sources = [
		{ package: "mcp", path: "src/index.ts", imports: ["../../host/src/config.ts", "../../host/src/core/secret.ts"] },
		{ package: "mcp", path: "src/deep/leaf.ts", imports: ["../../../host/src/core/other.js"] },
	];
	const issues = checkPackageBoundaries(
		privatePackages,
		sources,
		{ host: [], mcp: [] },
		{ mcp: ["host/src/config.ts"] },
	);
	assert.deepEqual(issues, [
		"hosted workspace reaches host internals: mcp/src/index.ts -> host/src/core/secret.ts (not in HOST_IMPORT_BASELINE)",
		"hosted workspace reaches host internals: mcp/src/deep/leaf.ts -> host/src/core/other.js (not in HOST_IMPORT_BASELINE)",
	]);
	assert.equal(
		checkPackageBoundaries(privatePackages, sources.slice(0, 1), { host: [], mcp: [] }, {}).length,
		2,
		"a hosted workspace without a baseline entry may not import any host file",
	);
	assert.deepEqual(
		checkPackageBoundaries(
			privatePackages,
			[{ package: "host", path: "src/index.ts", imports: ["../../host/src/core/secret.ts", "../../mcp/src/index.ts"] }],
			{ host: [], mcp: [] },
			{},
		),
		[],
		"the host may import its own files and its hosted workspaces",
	);
});

test("the committed host import baseline lists only existing host files of hosted workspaces", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	for (const [name, files] of Object.entries(HOST_IMPORT_BASELINE)) {
		const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
		assert.equal(manifest.octocodeSource?.host, "coding-agent", `${name} must be a hosted workspace`);
		assert.deepEqual([...files].sort(), files, `${name} baseline must stay sorted`);
		for (const file of files) assert.ok(existsSync(join(root, "packages", file)), `${file} no longer exists`);
	}
});

test("a private implementation cannot hide an outward import or an external cycle", () => {
	const fixtures = {
		...privatePackages,
		mcp: { ...privatePackages.mcp, dependencies: { "@app/agent": "1" } },
		agent: { name: "@app/agent", dependencies: { "@app/host": "1" } },
	};
	const issues = checkPackageBoundaries(
		fixtures,
		[{ package: "mcp", path: "src/index.ts", imports: ["../../agent/src/index.ts"] }],
		{ host: [], mcp: [], agent: ["host"] },
	);
	assert.ok(issues.some((issue) => issue.includes("forbidden import: mcp")));
	assert.ok(issues.some((issue) => issue.includes("relative package import: mcp")));
	assert.ok(issues.some((issue) => issue.includes("package cycle: host -> agent -> host")));
});

test("source workspace declarations require private ownership, a safe mount and a workspace dependency", () => {
	for (const change of [
		{ private: false },
		{ octocodeSource: { host: "missing", mount: "mcp" } },
		{ octocodeSource: { host: "mcp", mount: "mcp" } },
		{ octocodeSource: { host: "host", mount: "../escape" } },
	]) {
		assert.equal(
			sourceWorkspaceGroups({ ...privatePackages, mcp: { ...privatePackages.mcp, ...change } }).issues.length,
			1,
		);
	}
	assert.equal(sourceWorkspaceGroups({ ...privatePackages, host: { name: "@app/host" } }).issues.length, 1);
	assert.equal(
		sourceWorkspaceGroups({
			...privatePackages,
			host: { ...privatePackages.host, devDependencies: { "@app/mcp": "workspace:*", "@app/extra": "workspace:*" } },
			extra: { ...privatePackages.mcp, name: "@app/extra" },
		}).issues.length,
		1,
	);
	assert.ok(
		sourceWorkspaceGroups({
			...privatePackages,
			host: { ...privatePackages.host, octocodeSource: { host: "mcp", mount: "host" } },
		}).issues.length > 0,
	);
});

test("a private implementation ships its dependencies through the host without becoming a runtime dependency", () => {
	const mcp = { ...privatePackages.mcp, dependencies: { helper: "1.0.0" } };
	assert.ok(
		sourceWorkspaceGroups({ ...privatePackages, mcp }).issues.some((issue) =>
			issue.includes("must be shipped by its host"),
		),
	);
	assert.deepEqual(
		sourceWorkspaceGroups({
			...privatePackages,
			mcp,
			host: { ...privatePackages.host, dependencies: { helper: "1.0.0" } },
		}).issues,
		[],
	);
	assert.ok(
		sourceWorkspaceGroups({
			...privatePackages,
			host: { ...privatePackages.host, dependencies: { "@app/mcp": "workspace:*" } },
		}).issues.some((issue) => issue.includes("runtime dependency")),
	);
});

test("the filesystem gate detects deferred crossing imports without treating examples as dependencies", (t) => {
	const root = mkdtempSync(join(tmpdir(), "octocode-boundaries-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const name of ["contacts", "webview"]) {
		const directory = join(root, "packages", name);
		mkdirSync(join(directory, "src"), { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@app/${name}` }));
	}
	const file = join(root, "packages/contacts/src/example.ts");
	writeFileSync(file, 'const help = "import \'@app/webview\'";\n// import "@app/webview";');
	assert.deepEqual(scanPackageBoundaries(root), []);
	writeFileSync(file, 'const require = (value: string) => value;\nrequire("@app/webview");');
	assert.deepEqual(scanPackageBoundaries(root), []);
	writeFileSync(file, 'export const load = () => import /* deferred */ ("@app/webview");');
	assert.deepEqual(scanPackageBoundaries(root), [
		"forbidden import: contacts/src/example.ts -> webview",
		"undeclared import: contacts/src/example.ts -> webview",
	]);
});

test("a layer cannot import the layer above it unless its baseline lists the file", () => {
	const rules = [
		{
			name: "core-must-not-import-modes",
			from: "host/src/core/",
			to: "host/src/modes/",
			baseline: ["host/src/core/old.ts"],
		},
	];
	const source = (path) => ({ package: "host", path, imports: ["../modes/view.ts"] });
	assert.deepEqual(
		checkPackageBoundaries({ host: { name: "@app/host" } }, [source("src/core/old.ts")], { host: [] }, {}, rules),
		[],
	);
	assert.deepEqual(
		checkPackageBoundaries({ host: { name: "@app/host" } }, [source("src/core/new.ts")], { host: [] }, {}, rules),
		["core-must-not-import-modes: host/src/core/new.ts -> host/src/modes/view.ts (not in its baseline)"],
	);
	assert.deepEqual(
		checkPackageBoundaries({ host: { name: "@app/host" } }, [source("src/other/new.ts")], { host: [] }, {}, rules),
		[],
		"a file outside the layer is not constrained",
	);
});

test("the committed layer baselines list only existing, sorted files inside their layer", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	for (const rule of LAYER_RULES) {
		assert.deepEqual([...rule.baseline].sort(), rule.baseline, `${rule.name} baseline must stay sorted`);
		for (const file of rule.baseline) {
			assert.ok(file.startsWith(rule.from), `${file} is outside ${rule.from}`);
			assert.ok(existsSync(join(root, "packages", file)), `${file} no longer exists`);
		}
	}
});
