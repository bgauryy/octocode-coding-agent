import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPackageBoundaries, scanPackageBoundaries } from "./check-package-boundaries.mjs";
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
		),
		[],
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
