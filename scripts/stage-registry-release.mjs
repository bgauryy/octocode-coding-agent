#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { smokeTestCodingAgent, codingAgentName } from "./coding-agent-smoke.mjs";
import { execNpmSync } from "./npm-command.mjs";
import { publishedManifest } from "./publish-stage.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import {
	createInstallerManifest,
	stageRegistryManifest,
	validateRegistryLock,
	validateReleaseMetadata,
} from "./registry-release.mjs";

const options = {};
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "--prepare" || arg === "--verify") {
		options[arg] = true;
		continue;
	}
	if (!["--map", "--out", "--registry"].includes(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) {
		throw new Error(
			"Usage: stage-registry-release.mjs (--prepare|--verify) --map <reviewed.json> --out <directory> --registry <registry-url>",
		);
	}
	options[arg] = process.argv[++i];
}
if (
	!options["--map"] ||
	!options["--out"] ||
	!options["--registry"] ||
	Boolean(options["--prepare"]) === Boolean(options["--verify"])
) {
	throw new Error("Exactly one of --prepare or --verify and all of --map, --out, --registry are required");
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(options["--out"]);
if (existsSync(output) !== Boolean(options["--verify"]))
	throw new Error(`Release output must ${options["--verify"] ? "exist" : "not exist"}: ${output}`);
const relativeOutput = relative(repoRoot, output);
if (
	relativeOutput === "" ||
	(relativeOutput !== ".." && !relativeOutput.startsWith(`..${sep}`)) ||
	!isAbsolute(output)
) {
	throw new Error("Release output must be a new directory outside the source checkout");
}
const registry = new URL(options["--registry"]).href;
if (new URL(registry).protocol !== "https:" && !["localhost", "127.0.0.1"].includes(new URL(registry).hostname)) {
	throw new Error("Registry must use HTTPS or a disposable local fixture");
}
const mapping = JSON.parse(readFileSync(resolve(options["--map"]), "utf8"));
if (mapping.schemaVersion !== 1 || !mapping.packages || typeof mapping.packages !== "object") {
	throw new Error("Release mapping must have schemaVersion 1 and packages keyed by name");
}
const mapDigest = createHash("sha256").update(JSON.stringify(mapping)).digest("hex");
const home = mkdtempSync(join(tmpdir(), "octocode-release-home-"));
const env = {
	...process.env,
	HOME: home,
	USERPROFILE: home,
	npm_config_userconfig: join(home, "npmrc"),
	npm_config_cache: join(home, "npm-cache"),
	npm_config_registry: registry,
};
function npm(args, cwd) {
	return execNpmSync(args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
}
function pack(directory, destination) {
	const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", destination], directory));
	if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename)
		throw new Error(`Unexpected npm pack result: ${directory}`);
	return join(destination, packed[0].filename);
}
function metadata(name, version) {
	const data = JSON.parse(npm(["view", `${name}@${version}`, "--json", "--registry", registry], output));
	if (Array.isArray(data)) throw new Error(`Ambiguous registry metadata for ${name}@${version}`);
	return data;
}

if (options["--prepare"]) mkdirSync(output, { recursive: true });
try {
	const tarballs = join(output, "tarballs");
	const publicPackages = getPublicWorkspacePackages(join(repoRoot, "packages"));
	const workspaceVersions = Object.fromEntries(publicPackages.map((pkg) => [pkg.name, pkg.version]));
	for (const name of Object.keys(mapping.packages)) {
		if (Object.hasOwn(workspaceVersions, name)) throw new Error(`Reviewed mapping shadows workspace package ${name}`);
		if (Object.hasOwn(mapping.packages[name] ?? {}, "name"))
			throw new Error(`Reviewed mapping value must not set name: ${name}`);
	}
	let staged;
	if (options["--prepare"]) {
		mkdirSync(tarballs);
		staged = [];
		for (const pkg of publicPackages) {
			if (!existsSync(join(pkg.directory, "dist"))) throw new Error(`Build output missing: ${pkg.directory}/dist`);
			const scratch = mkdtempSync(join(home, "packed-source-"));
			const archive = pack(pkg.directory, scratch);
			const extracted = join(scratch, "extract");
			mkdirSync(extracted);
			execFileSync("tar", ["-xzf", archive, "-C", extracted]);
			const packageDirectory = join(extracted, "package");
			const sourceManifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
			const candidate = stageRegistryManifest(publishedManifest(sourceManifest), mapping.packages, workspaceVersions);
			if (candidate.name !== pkg.name || candidate.version !== pkg.version)
				throw new Error(`Packed manifest changed identity: ${pkg.name}`);
			writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify(candidate, null, "\t")}\n`);
			const tarball = pack(packageDirectory, tarballs);
			const contents = readFileSync(tarball);
			const integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`;
			staged.push({ name: pkg.name, version: pkg.version, tarball, integrity });
		}
		writeFileSync(
			join(output, "candidate.json"),
			`${JSON.stringify({ schemaVersion: 1, mapDigest, registry, packages: staged.map(({ name, version, tarball, integrity }) => ({ name, version, tarball: relative(output, tarball), integrity })) }, null, 2)}\n`,
		);
		console.log(`Candidate tarballs prepared for registry fixture: ${output}`);
	} else {
		const candidate = JSON.parse(readFileSync(join(output, "candidate.json"), "utf8"));
		if (
			candidate.schemaVersion !== 1 ||
			candidate.mapDigest !== mapDigest ||
			!Array.isArray(candidate.packages) ||
			candidate.packages.length !== publicPackages.length
		) {
			throw new Error("Candidate manifest does not match this reviewed mapping and public workspace set");
		}
		staged = candidate.packages.map((entry) => {
			const pkg = publicPackages.find((item) => item.name === entry.name && item.version === entry.version);
			const tarball = resolve(output, entry.tarball);
			if (
				!pkg ||
				dirname(tarball) !== tarballs ||
				!existsSync(tarball) ||
				`sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}` !== entry.integrity
			) {
				throw new Error(`Prepared candidate changed: ${entry.name}`);
			}
			return { ...entry, tarball };
		});
		if (new Set(staged.map((pkg) => pkg.name)).size !== publicPackages.length)
			throw new Error("Prepared candidate workspace set contains duplicates");
		const agent = staged.find((pkg) => pkg.name === codingAgentName);
		if (!agent) throw new Error(`Missing ${codingAgentName} package`);
		const agentManifest = JSON.parse(
			execFileSync("tar", ["-xOzf", agent.tarball, "package/package.json"], { encoding: "utf8" }),
		);
		for (const [name, reviewed] of Object.entries(mapping.packages)) {
			validateReleaseMetadata(name, reviewed, metadata(name, reviewed.version), registry);
		}
		const installerDirectory = join(output, "installer");
		rmSync(installerDirectory, { recursive: true, force: true });
		rmSync(join(output, "validated-installer"), { recursive: true, force: true });
		rmSync(join(output, "consumer"), { recursive: true, force: true });
		mkdirSync(installerDirectory);
		writeFileSync(
			join(installerDirectory, "package.json"),
			`${JSON.stringify(createInstallerManifest(agentManifest), null, "\t")}\n`,
		);
		// The disposable registry must already serve the *identical* candidate tarballs, or published versions
		// whose reviewed integrity matches. Production promotion cannot reuse a fixture-registry lock.
		npm(
			[
				"install",
				"--package-lock-only",
				"--omit=dev",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--registry",
				registry,
			],
			installerDirectory,
		);
		const lock = JSON.parse(readFileSync(join(installerDirectory, "package-lock.json"), "utf8"));
		const reviewedPackages = Object.fromEntries(
			[...staged, ...Object.entries(mapping.packages).map(([name, entry]) => ({ ...entry, name }))].map(
				({ name, version, integrity }) => [name, { version, integrity }],
			),
		);
		validateRegistryLock(lock, {
			registry,
			directName: codingAgentName,
			directVersion: agent.version,
			reviewedPackages,
			allowInstallScripts: ["@google/genai@2.21.0", "protobufjs@7.6.6"],
		});
		if (
			[...staged, ...Object.entries(mapping.packages).map(([name, entry]) => ({ ...entry, name }))].some(
				({ name }) =>
					!Object.keys(lock.packages).some(
						(path) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`,
					),
			)
		) {
			throw new Error("Reviewed candidate missing from resolved installer lock");
		}
		execFileSync(
			process.execPath,
			[
				join(repoRoot, "scripts/generate-coding-agent-install-lock.mjs"),
				"--resolution-dir",
				installerDirectory,
				"--out",
				join(output, "validated-installer"),
				"--registry",
				registry,
			],
			{ env, stdio: "inherit" },
		);
		const consumer = join(output, "consumer");
		mkdirSync(consumer);
		const directTarball = pathToFileURL(agent.tarball).href;
		writeFileSync(
			join(consumer, "package.json"),
			`${JSON.stringify({ private: true, type: "module", dependencies: { [codingAgentName]: directTarball } })}\n`,
		);
		npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry], consumer);
		const consumerLock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
		validateRegistryLock(consumerLock, {
			registry,
			directName: codingAgentName,
			directVersion: agent.version,
			directTarball,
			reviewedPackages: {
				...reviewedPackages,
				[codingAgentName]: { version: agent.version, integrity: agent.integrity },
			},
			allowInstallScripts: ["@google/genai@2.21.0", "protobufjs@7.6.6"],
		});
		const installed = realpathSync(join(consumer, "node_modules", codingAgentName));
		if (!installed.startsWith(`${realpathSync(consumer)}/`))
			throw new Error(`Installed coding agent escapes consumer: ${installed}`);
		smokeTestCodingAgent(consumer, process.execPath, { strictRuntime: true });
		writeFileSync(
			join(output, "validation.json"),
			`${JSON.stringify({ schemaVersion: 1, mapDigest, registry, validatedAt: new Date().toISOString() }, null, 2)}\n`,
		);
		console.log(`Registry candidate validated in isolated consumer: ${output}`);
	}
} catch (error) {
	if (options["--prepare"]) rmSync(output, { recursive: true, force: true });
	else rmSync(join(output, "validation.json"), { force: true });
	throw error;
} finally {
	rmSync(home, { recursive: true, force: true });
}
