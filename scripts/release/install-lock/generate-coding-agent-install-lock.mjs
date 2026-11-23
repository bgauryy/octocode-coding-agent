#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateInstallLock } from "./install-lock-build.mjs";
import { readJson } from "./install-lock-entries.mjs";
import { allowedInstallScriptPackages } from "./install-lock-validate.mjs";
import { validateLocalDependencies } from "../local-dependencies.mjs";
import { validateRegistryLock } from "../registry-release.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const outputDir = join(codingAgentDir, "install-lock");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const outputPackageJsonPath = join(outputDir, "package.json");
const outputLockfilePath = join(outputDir, "package-lock.json");

const cliArgs = process.argv.slice(2);
const options = {};
for (let index = 0; index < cliArgs.length; index++) {
	const arg = cliArgs[index];
	if (["--resolution-dir", "--out", "--registry"].includes(arg)) {
		if (!cliArgs[index + 1] || cliArgs[index + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
		options[arg] = cliArgs[++index];
	} else if (arg !== "--check" && arg !== "--require-registry") {
		throw new Error(`Unknown argument: ${arg}`);
	}
}
const args = new Set(cliArgs.filter((arg) => arg.startsWith("--")));
const checkOnly = args.has("--check");
const requireRegistry = args.has("--require-registry");

if (options["--resolution-dir"]) {
	if (!options["--out"] || !options["--registry"])
		throw new Error("Dedicated resolution requires --out and --registry");
	const resolutionDir = resolve(options["--resolution-dir"]);
	const targetDir = resolve(options["--out"]);
	const registryUrl = new URL(options["--registry"]);
	if (targetDir === outputDir && ["localhost", "127.0.0.1"].includes(registryUrl.hostname)) {
		throw new Error("A fixture registry cannot produce the production installer lock");
	}
	const manifest = JSON.parse(readFileSync(join(resolutionDir, "package.json"), "utf8"));
	const lock = JSON.parse(readFileSync(join(resolutionDir, "package-lock.json"), "utf8"));
	const dependencies = Object.entries(manifest.dependencies ?? {});
	if (dependencies.length !== 1 || dependencies[0][0] !== "@octocodeai/octocode-agent") {
		throw new Error("Dedicated installer manifest must name only @octocodeai/octocode-agent");
	}
	validateRegistryLock(lock, {
		registry: options["--registry"],
		directName: dependencies[0][0],
		directVersion: dependencies[0][1],
		allowInstallScripts: [...allowedInstallScriptPackages.keys()],
	});
	const packageContent = `${JSON.stringify(manifest, null, "\t")}\n`;
	const lockContent = `${JSON.stringify(lock, null, "\t")}\n`;
	if (checkOnly) {
		if (
			!existsSync(join(targetDir, "package.json")) ||
			!existsSync(join(targetDir, "package-lock.json")) ||
			readFileSync(join(targetDir, "package.json"), "utf8") !== packageContent ||
			readFileSync(join(targetDir, "package-lock.json"), "utf8") !== lockContent
		) {
			throw new Error(`Dedicated installer lock is missing or stale: ${targetDir}`);
		}
	} else {
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "package.json"), packageContent);
		writeFileSync(join(targetDir, "package-lock.json"), lockContent);
	}
	console.log(`Dedicated registry installer lock validated: ${targetDir}`);
	process.exit(0);
}
if (options["--out"] || options["--registry"]) throw new Error("--out and --registry require --resolution-dir");

try {
	const codingAgentManifest = readJson(join(codingAgentDir, "package.json"));
	const localDependencies = Object.entries(codingAgentManifest.dependencies ?? {}).filter(([, specifier]) =>
		/^(file|link):/.test(specifier),
	);
	if (localDependencies.length > 0) {
		if (requireRegistry) {
			throw new Error(
				"Cannot release a registry installer with local dependencies. Replace file: dependencies with reviewed registry versions first.",
			);
		}
		const validated = validateLocalDependencies(codingAgentDir);
		console.log(`Validated local dependencies: ${validated.join(", ")}`);
		console.log(
			"Local dependency mode; registry installer artifacts are unavailable. Replace file: dependencies with reviewed registry versions, then regenerate with --require-registry.",
		);
		process.exit(0);
	}
	const { installerPackageJson, installLock } = generateInstallLock({ repoRoot, codingAgentDir, rootLockfilePath });
	const packageJsonContent = `${JSON.stringify(installerPackageJson, null, "\t")}\n`;
	const lockfileContent = `${JSON.stringify(installLock, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(outputPackageJsonPath) || !existsSync(outputLockfilePath)) {
			console.error("packages/coding-agent/install-lock is missing generated files.");
			console.error("Run: yarn run install-lock:coding-agent");
			process.exit(1);
		}
		const currentPackageJson = readFileSync(outputPackageJsonPath, "utf8");
		const currentLockfile = readFileSync(outputLockfilePath, "utf8");
		if (currentPackageJson !== packageJsonContent || currentLockfile !== lockfileContent) {
			console.error("packages/coding-agent/install-lock is out of date.");
			console.error("Run: yarn run install-lock:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/install-lock is up to date.");
	} else {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(outputPackageJsonPath, packageJsonContent);
		writeFileSync(outputLockfilePath, lockfileContent);
		const packageCount = Object.keys(installLock.packages).length - 1;
		const platformPackageCount = Object.values(installLock.packages).filter(
			(entry) => entry.os || entry.cpu || entry.libc,
		).length;
		console.log(
			`Wrote packages/coding-agent/install-lock/package.json and package-lock.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
