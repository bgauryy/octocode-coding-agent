import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stageHostSources } from "./build-host-sources.mjs";
import { execYarnSync } from "./yarn-command.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "octocode source workspace "));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (path, content) => {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
	};
	write("packages/host/package.json", {
		name: "@fixture/host",
		type: "module",
		devDependencies: { "@fixture/mcp": "workspace:*" },
	});
	write("packages/mcp/package.json", {
		name: "@fixture/mcp",
		private: true,
		type: "module",
		octocodeSource: { host: "host", mount: "mcp" },
	});
	write("packages/host/tsconfig.build.json", {
		compilerOptions: {
			target: "es2022",
			module: "nodenext",
			declaration: true,
			sourceMap: true,
			declarationMap: true,
			rewriteRelativeImportExtensions: true,
			types: [],
		},
	});
	write("packages/host/src/config.ts", 'export const prefix = "host";');
	write(
		"packages/host/src/index.ts",
		'export { value } from "../../mcp/src/index.ts";\nexport const load = () => import("../../mcp/src/index.ts");',
	);
	write(
		"packages/mcp/src/index.ts",
		'import { prefix } from "../../host/src/config.ts";\nexport const value = `${prefix}:mcp`;',
	);
	write("packages/mcp/src/data.json", { preserved: true });
	write("packages/host/.stage/package.json", { type: "module" });
	return { root, write, stage: join(root, "packages/host/.stage") };
}

test("builds a private source workspace into the host with working static and dynamic imports", async (t) => {
	const { root, stage } = fixture(t);
	stageHostSources(root, "host", stage);
	execYarnSync(["exec", "tsc", "-p", join(stage, "tsconfig.json")], { stdio: "pipe" });
	const dist = join(root, "packages/host/dist");
	const built = await import(pathToFileURL(join(dist, "index.js")).href);
	assert.equal(built.value, "host:mcp");
	assert.equal((await built.load()).value, "host:mcp");
	assert.match(readFileSync(join(dist, "index.d.ts"), "utf8"), /\.\/mcp\/index\.ts/);
	assert.deepEqual(JSON.parse(readFileSync(join(stage, "src/mcp/data.json"))), { preserved: true });
	assert.deepEqual(readdirSync(join(root, "packages/mcp")), ["package.json", "src"]);
});

test("refuses a second source owner at the host mount", (t) => {
	const { root, stage, write } = fixture(t);
	write("packages/host/src/mcp/index.ts", "export {};");
	assert.throws(() => stageHostSources(root, "host", stage), /Source mount already exists/);
});

test("staging preserves import examples in strings and comments", (t) => {
	const { root, stage, write } = fixture(t);
	const source = `export const example = "import '../../mcp/src/index.ts'";\n// import '../../mcp/src/index.ts'\n`;
	write("packages/host/src/example.ts", source);
	stageHostSources(root, "host", stage);
	assert.equal(readFileSync(join(stage, "src/example.ts"), "utf8"), source);
});

test("relocates a deferred import separated from its argument by a comment", async (t) => {
	const { root, stage, write } = fixture(t);
	write("packages/host/src/index.ts", 'export const load = () => import /* deferred */ ("../../mcp/src/index.ts");');
	stageHostSources(root, "host", stage);
	execYarnSync(["exec", "tsc", "-p", join(stage, "tsconfig.json")], { stdio: "pipe" });
	const built = await import(pathToFileURL(join(root, "packages/host/dist/index.js")).href);
	assert.equal((await built.load()).value, "host:mcp");
});
