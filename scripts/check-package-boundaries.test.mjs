import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPackageBoundaries, scanPackageBoundaries } from "./check-package-boundaries.mjs";
import { LAYER_RULES } from "./layer-import-baseline.mjs";
import { sourceWorkspaceGroups } from "./source-workspaces.mjs";
const packages = {
	contracts: { name: "@app/contracts" },
	webview: { name: "@app/webview", dependencies: { "@app/contracts": "1" } },
	agent: { name: "@app/agent" },
};
const policy = { contracts: [], webview: ["contracts"], agent: [] };
test("accepts declared inward imports and type imports", () => {
	assert.deepEqual(
		checkPackageBoundaries(
			packages,
			[{ package: "webview", path: "src/view.ts", imports: ["@app/contracts/events"] }],
			policy,
		),
		[],
	);
});
test("rejects outward and undeclared imports even when type-only", () => {
	const issues = checkPackageBoundaries(
		packages,
		[{ package: "contracts", path: "src/types.ts", imports: ["@app/webview"] }],
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

test("accepts the host importing its hosted workspace within one compilation", () => {
	assert.deepEqual(
		checkPackageBoundaries(
			privatePackages,
			[{ package: "host", path: "src/index.ts", imports: ["../../mcp/src/index.ts"] }],
			{ host: [], mcp: [] },
		),
		[],
	);
});

test("a hosted workspace imports a hosted sibling by package name, not by relative path", () => {
	const packages = {
		host: { name: "@app/host", devDependencies: { "@app/acp": "workspace:*", "@app/common": "workspace:*" } },
		common: { name: "@app/common", private: true, octocodeSource: { host: "host", mount: "common" } },
		acp: {
			name: "@app/acp",
			private: true,
			devDependencies: { "@app/common": "workspace:*" },
			octocodeSource: { host: "host", mount: "acp" },
		},
	};
	const policy = { host: [], common: [], acp: ["common"] };
	assert.deepEqual(
		checkPackageBoundaries(packages, [{ package: "acp", path: "src/a.ts", imports: ["@app/common/text"] }], policy),
		[],
	);
	const issues = checkPackageBoundaries(
		packages,
		[{ package: "acp", path: "src/a.ts", imports: ["../../common/src/text.ts"] }],
		policy,
	);
	assert.deepEqual(issues, [
		"relative sibling import: acp/src/a.ts -> ../../common/src/text.ts (import it by package name and declare it)",
	]);
});

test("a hosted workspace cannot import any host file", () => {
	const sources = [
		{ package: "mcp", path: "src/index.ts", imports: ["../../host/src/config.ts", "../../host/src/core/secret.ts"] },
		{ package: "mcp", path: "src/deep/leaf.ts", imports: ["../../../host/src/core/other.js"] },
	];
	assert.deepEqual(checkPackageBoundaries(privatePackages, sources, { host: [], mcp: [] }), [
		"hosted workspace reaches host internals: mcp/src/index.ts -> host/src/config.ts (use a host port)",
		"hosted workspace reaches host internals: mcp/src/index.ts -> host/src/core/secret.ts (use a host port)",
		"hosted workspace reaches host internals: mcp/src/deep/leaf.ts -> host/src/core/other.js (use a host port)",
	]);
	assert.deepEqual(
		checkPackageBoundaries(
			privatePackages,
			[{ package: "host", path: "src/index.ts", imports: ["../../host/src/core/secret.ts", "../../mcp/src/index.ts"] }],
			{ host: [], mcp: [] },
		),
		[],
		"the host may import its own files and its hosted workspaces",
	);
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

test("hosted workspaces reach each other only along their policy edges", () => {
	const fixtures = {
		host: { name: "@app/host", devDependencies: { "@app/mcp": "workspace:*", "@app/common": "workspace:*" } },
		mcp: { name: "@app/mcp", private: true, octocodeSource: { host: "host", mount: "mcp" } },
		common: { name: "@app/common", private: true, octocodeSource: { host: "host", mount: "common" } },
	};
	const sources = (from, to) => [{ package: from, path: "src/index.ts", imports: [`../../${to}/src/index.ts`] }];
	const policy = { host: ["common"], mcp: ["common"], common: [] };
	assert.deepEqual(checkPackageBoundaries(fixtures, sources("mcp", "common"), policy), []);
	assert.deepEqual(checkPackageBoundaries(fixtures, sources("host", "mcp"), policy), []);
	assert.ok(
		checkPackageBoundaries(fixtures, sources("common", "mcp"), policy).includes(
			"forbidden import: common/src/index.ts -> mcp",
		),
	);
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
	for (const name of ["contracts", "webview"]) {
		const directory = join(root, "packages", name);
		mkdirSync(join(directory, "src"), { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@app/${name}` }));
	}
	const file = join(root, "packages/contracts/src/example.ts");
	writeFileSync(file, 'const help = "import \'@app/webview\'";\n// import "@app/webview";');
	assert.deepEqual(scanPackageBoundaries(root), []);
	writeFileSync(file, 'const require = (value: string) => value;\nrequire("@app/webview");');
	assert.deepEqual(scanPackageBoundaries(root), []);
	writeFileSync(file, 'export const load = () => import /* deferred */ ("@app/webview");');
	assert.deepEqual(scanPackageBoundaries(root), [
		"forbidden import: contracts/src/example.ts -> webview",
		"undeclared import: contracts/src/example.ts -> webview",
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
		checkPackageBoundaries({ host: { name: "@app/host" } }, [source("src/core/old.ts")], { host: [] }, rules),
		[],
	);
	assert.deepEqual(
		checkPackageBoundaries(
			{ host: { name: "@app/host" } },
			[source("src/core/old.ts"), source("src/core/new.ts")],
			{ host: [] },
			rules,
		),
		["core-must-not-import-modes: host/src/core/new.ts -> host/src/modes/view.ts (not in its baseline)"],
	);
	assert.deepEqual(
		checkPackageBoundaries(
			{ host: { name: "@app/host" } },
			[source("src/core/old.ts"), source("src/other/new.ts")],
			{ host: [] },
			rules,
		),
		[],
		"a file outside the layer is not constrained",
	);
});

test("a rule with several target prefixes catches each form of the import", () => {
	const rules = [
		{
			name: "core-must-not-import-mcp",
			from: "host/src/core/",
			to: ["@app/mcp", "mcp/src/"],
			baseline: ["host/src/core/old.ts"],
		},
	];
	const sources = [
		{ package: "host", path: "src/core/old.ts", imports: ["@app/mcp"] },
		{ package: "host", path: "src/core/bare.ts", imports: ["@app/mcp/status"] },
		{ package: "host", path: "src/core/relative.ts", imports: ["../../../mcp/src/status.ts"] },
	];
	assert.deepEqual(checkPackageBoundaries(privatePackages, sources, { host: [], mcp: [] }, rules), [
		"core-must-not-import-mcp: host/src/core/bare.ts -> @app/mcp/status (not in its baseline)",
		"core-must-not-import-mcp: host/src/core/relative.ts -> mcp/src/status.ts (not in its baseline)",
	]);
	assert.deepEqual(
		checkPackageBoundaries(
			privatePackages,
			[{ package: "host", path: "src/core/old.ts", imports: [] }],
			{ host: [], mcp: [] },
			rules,
		),
		[
			"core-must-not-import-mcp: host/src/core/old.ts no longer imports @app/mcp or mcp/src/ (remove it from its baseline)",
		],
	);
});

test("a baseline entry that no longer imports its layer fails until it is removed", () => {
	const rules = [
		{
			name: "core-must-not-import-octocode",
			from: "host/src/core/",
			to: "host/src/octocode/",
			baseline: ["host/src/core/fixed.ts", "host/src/core/gone.ts"],
		},
	];
	const sources = [
		{ package: "host", path: "src/core/fixed.ts", imports: ["./local.ts"] },
		{ package: "host", path: "src/core/other.ts", imports: ["../octocode/index.ts"] },
	];
	assert.deepEqual(checkPackageBoundaries({ host: { name: "@app/host" } }, sources, { host: [] }, rules), [
		"core-must-not-import-octocode: host/src/core/other.ts -> host/src/octocode/index.ts (not in its baseline)",
		"core-must-not-import-octocode: host/src/core/fixed.ts no longer imports host/src/octocode/ (remove it from its baseline)",
		"core-must-not-import-octocode: host/src/core/gone.ts no longer imports host/src/octocode/ (remove it from its baseline)",
	]);
});

test("core stays a layer below the octocode feature layer", () => {
	const rule = LAYER_RULES.find((entry) => entry.name === "core-must-not-import-octocode");
	assert.ok(rule, "the core -> octocode layer rule must stay registered");
	assert.equal(rule.from, "coding-agent/src/core/");
	assert.equal(rule.to, "coding-agent/src/octocode/");
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
