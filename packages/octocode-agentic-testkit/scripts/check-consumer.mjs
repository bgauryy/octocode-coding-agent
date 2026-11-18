#!/usr/bin/env node
// Proves a project outside this repository can use the built package by name. It creates a temporary project with
// the package and the repository's Vitest linked into node_modules, loads every `exports` subpath on plain Node
// (import and require, no type stripping), typechecks a consumer against the `dist` types (NodeNext and Bundler
// resolution, plus matcher typings through tsconfig `types`), and runs its tests with a `testkitConfig` Vitest config.
//   yarn check:consumer [--keep] [--tsc <path>]     needs a fresh build; --keep leaves the project for inspection;
//                                                   --tsc typechecks with another TypeScript (e.g. a TypeScript 5
//                                                   `bin/tsc`); the Node that runs this script runs every step
//   node scripts/check-consumer.mjs --dist-status   prints "fresh" or why dist cannot be checked, and exits 0
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
const NAME = MANIFEST.name;
const BUILD = `yarn workspace ${NAME} run build`;
const fromPkg = createRequire(join(PKG_DIR, "package.json"));
const packageRoot = (name) => dirname(fromPkg.resolve(`${name}/package.json`));

/** Why `dist` cannot stand for the current sources (missing, partial or older than a source file), or undefined. */
function distProblem() {
	const dist = join(PKG_DIR, "dist");
	if (!existsSync(dist)) return `dist is missing: run \`${BUILD}\``;
	const sources = readdirSync(join(PKG_DIR, "src"), { recursive: true, encoding: "utf8" }).filter((f) =>
		f.endsWith(".ts"),
	);
	for (const rel of sources) {
		const srcTime = statSync(join(PKG_DIR, "src", rel)).mtimeMs;
		for (const out of [rel.replace(/\.ts$/, ".js"), rel.replace(/\.ts$/, ".d.ts")]) {
			const file = join(dist, out);
			if (!existsSync(file)) return `dist lacks ${out}: run \`${BUILD}\``;
			if (statSync(file).mtimeMs < srcTime) return `dist is older than src/${rel}: run \`${BUILD}\``;
		}
	}
	const known = new Set(sources.map((rel) => rel.replace(/\.ts$/, ".js")));
	const orphan = readdirSync(dist, { recursive: true, encoding: "utf8" }).find(
		(f) => f.endsWith(".js") && !known.has(f),
	);
	return orphan ? `dist/${orphan} has no source: run \`${BUILD}\`` : undefined;
}

/** Each `exports` subpath with the conditions a consumer resolves; a missing target is an error. */
function subpaths() {
	return Object.entries(MANIFEST.exports).map(([key, conditions]) => {
		for (const condition of ["source", "types", "import", "default"]) {
			const target = conditions[condition];
			if (typeof target !== "string") throw new StepFailed(`exports["${key}"] has no "${condition}" condition`);
			if (!existsSync(join(PKG_DIR, target)))
				throw new StepFailed(`exports["${key}"].${condition} is missing: ${target}`);
		}
		return key === "." ? NAME : `${NAME}/${key.slice(2)}`;
	});
}

const COMPILER_OPTIONS = {
	target: "ES2024",
	lib: ["ES2024"],
	module: "NodeNext",
	moduleResolution: "NodeNext",
	strict: true,
	noEmit: true,
	// Our declaration files are checked too, not trusted.
	skipLibCheck: false,
	types: ["node"],
};

const json = (value) => `${JSON.stringify(value, null, "\t")}\n`;

const FILES = {
	"package.json": json({ name: "testkit-consumer", private: true, type: "module" }),
	"tsconfig.json": json({ compilerOptions: COMPILER_OPTIONS, include: ["agent.test.ts", "vitest.config.ts"] }),
	"tsconfig.bundler.json": json({
		extends: "./tsconfig.json",
		compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
	}),
	// The matcher typings without importing the kit: only tsconfig `types` names the setup entry.
	"tsconfig.setup.json": json({
		extends: "./tsconfig.json",
		compilerOptions: { types: ["node", `${NAME}/setup`] },
		include: ["setup-only.test.ts"],
	}),
	// Control for the above: without the `types` entry the same file must not typecheck.
	"tsconfig.no-setup.json": json({ extends: "./tsconfig.json", include: ["setup-only.test.ts"] }),
	"imports.mjs": [
		'import { createRequire } from "node:module";',
		"const require = createRequire(import.meta.url);",
		"for (const spec of process.argv.slice(2)) {",
		"\tawait import(spec);",
		"\trequire(spec);",
		"}",
		"",
	].join("\n"),
	"vitest.config.ts": [
		`import { testkitConfig } from "${NAME}/config";`,
		'import { defineConfig } from "vitest/config";',
		"",
		'export default defineConfig({ test: testkitConfig({ include: ["*.test.ts"], testTimeout: 30_000 }) });',
		"",
	].join("\n"),
	"agent.test.ts": [
		`import { agentSuite, referenceAdapter, script, startGateway, type Gateway } from "${NAME}";`,
		'import { expect, it } from "vitest";',
		"",
		'const steps = () => script([{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, { text: "done" }]);',
		"",
		'it("calls the scripted tool", async () => {',
		"\tconst gw: Gateway = await startGateway({ responder: steps() });",
		"\tconst session = await referenceAdapter({ trace: gw.trace }).start({ gatewayUrl: gw.url });",
		"\ttry {",
		'\t\tawait session.run("say hi");',
		'\t\texpect(gw.trace).toHaveCalledTool("echo");',
		"\t} finally {",
		"\t\tawait session.close();",
		"\t\tawait gw.close();",
		"\t}",
		"});",
		"",
		'agentSuite("consumer suite", { adapter: ({ trace }) => referenceAdapter({ trace }), gateway: () => ({ responder: steps() }), runs: 2 }, (t) => {',
		'\tt.test("calls the scripted tool on every run", async ({ run, expect }) => {',
		'\t\tconst turn = await run("say hi");',
		'\t\texpect(turn.trace).toHaveCalledTool("echo");',
		"\t});",
		"});",
		"",
	].join("\n"),
	"setup-only.test.ts": [
		'import { expect, expectTypeOf, it } from "vitest";',
		"",
		"// No import of the kit: testkitConfig's setupFiles registers the matchers.",
		'it("has the matchers without importing the kit", () => {',
		'\texpect(expect({}).toHaveCalledTool).toBeTypeOf("function");',
		"\texpectTypeOf(expect({}).toHaveCalledTool).toBeFunction();",
		"});",
		"",
	].join("\n"),
};

class StepFailed extends Error {}

/** Runs one step in the consumer project; a non-zero exit (or a zero one when `expectFailure`) fails the check. */
function step(label, cwd, env, args, { expectFailure = false, timeout = 120_000 } = {}) {
	const r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout });
	if (r.error) throw new StepFailed(`${label}: ${r.error.message}`);
	const output = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
	if ((r.status === 0) === expectFailure) {
		const tail = output.trim().split("\n").slice(-60).join("\n");
		throw new StepFailed(
			`${label}: exit ${r.status ?? r.signal}${expectFailure ? " (expected a failure)" : ""}\n${tail}`,
		);
	}
	return output;
}

function link(target, path) {
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path, "dir");
}

function checkConsumer(keep, tscPath) {
	const specs = subpaths();
	const dir = mkdtempSync(join(tmpdir(), "testkit-consumer-"));
	try {
		for (const [file, text] of Object.entries(FILES)) writeFileSync(join(dir, file), text);
		link(PKG_DIR, join(dir, "node_modules", ...NAME.split("/")));
		link(packageRoot("vitest"), join(dir, "node_modules", "vitest"));
		link(packageRoot("@types/node"), join(dir, "node_modules", "@types", "node"));
		const reportDir = join(dir, "report");
		// The parent run's Vitest and testkit variables would leak a worker identity and run directories.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([k]) => !/^(VITEST|TESTKIT_)/.test(k) && k !== "FORCE_COLOR"),
		);
		Object.assign(env, { NO_COLOR: "1", TESTKIT_REPORT_DIR: reportDir });

		step("plain Node import and require", dir, env, ["--no-experimental-strip-types", "imports.mjs", ...specs]);
		const tsc = tscPath ?? join(packageRoot("typescript"), "bin", "tsc");
		const version = spawnSync(process.execPath, [tsc, "--version"], { encoding: "utf8" }).stdout.trim();
		for (const project of ["tsconfig.json", "tsconfig.bundler.json", "tsconfig.setup.json"])
			step(`tsc -p ${project}`, dir, env, [tsc, "-p", project]);
		step("tsc -p tsconfig.no-setup.json", dir, env, [tsc, "-p", "tsconfig.no-setup.json"], { expectFailure: true });

		const out = step("vitest run", dir, env, [join(packageRoot("vitest"), "vitest.mjs"), "run"]);
		const tests = /Tests\s+(\d+) passed \((\d+)\)/.exec(out);
		if (!tests || tests[1] !== tests[2]) throw new StepFailed(`vitest run: no clean pass in the output\n${out}`);
		for (const report of ["testkit-cache-report.json", "testkit-agent-report.json"])
			if (!existsSync(join(reportDir, report))) throw new StepFailed(`vitest run: ${report} was not written`);
		return `consumer ok on Node ${process.versions.node} with ${version}: ${specs.length} subpaths load on plain Node; tsc clean (NodeNext, Bundler, setup types); vitest ${tests[1]} passed with testkitConfig; cache and agent reports written${keep ? `; kept ${dir}` : ""}`;
	} finally {
		if (!keep) rmSync(dir, { recursive: true, force: true });
	}
}

const args = process.argv.slice(2);
if (args.includes("--dist-status")) {
	process.stdout.write(`${distProblem() ?? "fresh"}\n`);
} else {
	const problem = distProblem();
	if (problem) {
		process.stderr.write(`check-consumer: ${problem}\n`);
		process.exit(1);
	}
	try {
		const at = args.indexOf("--tsc");
		const tscPath = at === -1 ? undefined : args[at + 1];
		if (at !== -1 && (!tscPath || !existsSync(tscPath))) {
			process.stderr.write(`check-consumer: --tsc needs the path of an existing tsc, got ${tscPath ?? "nothing"}\n`);
			process.exit(2);
		}
		process.stdout.write(`${checkConsumer(args.includes("--keep"), tscPath)}\n`);
	} catch (e) {
		if (!(e instanceof StepFailed)) throw e;
		process.stderr.write(`check-consumer failed at ${e.message}\n`);
		process.exit(1);
	}
}
