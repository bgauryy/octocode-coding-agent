#!/usr/bin/env node
/**
 * Release script for Octocode
 *
 * Usage:
 *   node scripts/release/release.mjs <major|minor|patch>
 *   node scripts/release/release.mjs <x.y.z>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump version via yarn run version:xxx or set an explicit version
 * 3. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 4. Regenerate release artifacts
 * 5. Run checks and tests
 * 6. Commit and tag the release
 * 7. Add new [Unreleased] section to changelogs
 * 8. Commit next-cycle changelog updates
 * 9. Push main and the tag; publish afterwards with `yarn run publish`
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [
		...new Set(
			(output || "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`yarn run version:${target}`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}

		console.log(`Setting explicit version (${target})...`);
		run(
			`yarn run version:set ${target} && node scripts/release/sync-versions.js && yarn install --mode=update-lockfile`,
		);
	}

	// Install from the final dependency graph; the lockfile must already hold it.
	run("yarn install --immutable");
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 3. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 4. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("yarn run generate:models");
run("yarn run check:model-data");
console.log();

// 5. Run checks and tests
console.log("Running checks...");
run("yarn run check");
console.log();

console.log("Building packages for tests...");
run("yarn run build:offline");
console.log();

// OCTOCODE_RELEASE_SKIP_TESTS=1 skips the test suite, e.g. when it already passed in `yarn run release:local`
// and an overloaded machine makes timing-sensitive tests fail. Checks and the install check still run.
if (process.env.OCTOCODE_RELEASE_SKIP_TESTS === "1") {
	console.log("Skipping tests (OCTOCODE_RELEASE_SKIP_TESTS=1)\n");
} else {
	console.log("Running tests...");
	run("./test.sh");
	console.log();
}

console.log("Checking the packed coding-agent consumer install...");
run("yarn run check:package-install");
console.log();

// 6. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 7. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 8. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 9. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Prepared release v${version}. Publish it with: yarn run publish ===`);
