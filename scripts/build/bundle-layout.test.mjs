import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUNDLE_CODE_FILES, FAST_COMMANDS, MIN_NODE, launcherSource, workerForeignModules } from "./bundle-layout.mjs";

/** A bundle folder whose files print which of them ran, with `cli.js` as the build writes it. */
function stubBundle(t) {
	const directory = mkdtempSync(join(tmpdir(), "bundle-layout-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(
		join(directory, "octocode.js"),
		'export const runCli = () => console.log("bundle", process.argv.slice(2).join(" "));\nexport const runApiCli = () => console.log("api");\n',
	);
	for (const { file, run } of FAST_COMMANDS)
		writeFileSync(join(directory, file), `export const ${run} = () => console.log("${file}");\n`);
	writeFileSync(join(directory, "cli.js"), launcherSource("runCli", FAST_COMMANDS));
	writeFileSync(join(directory, "octocode-api.js"), launcherSource("runApiCli"));
	return (launcher, ...args) =>
		execFileSync(process.execPath, [join(directory, launcher), ...args], { encoding: "utf8" }).trim();
}

test("an older Node gets the version message and exit code 1, before the bundle loads", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "bundle-guard-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "octocode.js"), 'throw new Error("bundle loaded");\n');
	writeFileSync(join(directory, "cli.js"), launcherSource("runCli", FAST_COMMANDS));
	writeFileSync(
		join(directory, "fake-version.mjs"),
		'Object.defineProperty(process, "version", { value: "v22.1.0" });\nObject.defineProperty(process, "versions", { value: { ...process.versions, node: "22.1.0" } });\n',
	);
	const result = spawnSync(
		process.execPath,
		["--import", join(directory, "fake-version.mjs"), join(directory, "cli.js")],
		{
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 1);
	assert.equal(
		result.stderr.trim(),
		"Octocode needs Node >= 24.15.0 (found v22.1.0). Install the current LTS from https://nodejs.org",
	);
});

test("the guard's floor is the package's engines floor", () => {
	const engines = JSON.parse(
		readFileSync(new URL("../../packages/coding-agent/package.json", import.meta.url), "utf8"),
	).engines;
	assert.equal(engines.node, `>=${MIN_NODE.join(".")}`);
});

test("a fast command given alone loads only its own file", (t) => {
	const launch = stubBundle(t);
	const run = (...args) => launch("cli.js", ...args);
	for (const flag of ["--version", "-v"]) assert.equal(run(flag), "version.js");
	for (const flag of ["--help", "-h"]) assert.equal(run(flag), "help.js");
});

test("anything else loads the bundle, a fast flag among other arguments included", (t) => {
	const launch = stubBundle(t);
	const run = (...args) => launch("cli.js", ...args);
	assert.equal(run(), "bundle");
	assert.equal(run("-p", "hi"), "bundle -p hi");
	assert.equal(run("--version", "--offline"), "bundle --version --offline");
	assert.equal(run("mcp", "--help"), "bundle mcp --help");
	assert.equal(run("--Version"), "bundle --Version");
});

test("a launcher without fast commands always loads the bundle", (t) => {
	const launch = stubBundle(t);
	assert.equal(launch("octocode-api.js", "--version"), "api");
});

test("launchers stay small and every fast command's file is a listed code file", () => {
	// `publish-stage.mjs` refuses a file beside the bundle larger than this unless it is a listed code file.
	assert.ok(Buffer.byteLength(launcherSource("runCli", FAST_COMMANDS)) <= 1024);
	for (const { file } of FAST_COMMANDS) assert.ok(BUNDLE_CODE_FILES.has(file), file);
});

test("a worker may not bundle provider SDKs or the terminal UI", () => {
	const ids = [
		"/repo/packages/db/src/writer/worker-entry.ts",
		"/repo/packages/common/dist/clip.js",
		"/repo/packages/ai/dist/index.js",
		"/repo/packages/tui/dist/utils/ansi-codes.js",
		"/repo/node_modules/@ai-sdk/openai/dist/index.mjs",
		"/repo/node_modules/ai/dist/index.mjs",
		"/repo/node_modules/highlight.js/lib/core.js",
		"/repo/node_modules/graceful-fs/graceful-fs.js",
		"C:\\repo\\packages\\tui\\dist\\index.js",
	];
	assert.deepEqual(workerForeignModules(ids), [ids[2], ids[3], ids[4], ids[5], ids[6], ids[8]]);
});
