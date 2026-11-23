#!/usr/bin/env node
/**
 * Publishes @octocodeai/octocode-agent. The agentic testkit has its own release. Run through `yarn run publish` (or `publish:dry`), which
 * builds and checks first. Every gate runs before anything reaches npm:
 * one agent release target, a clean tree, the exact dependency versions on npm, a verified tarball with a clean manifest, and a
 * real install and session from that tarball. `--use name@version` tries another dependency version in a dry run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import semver from "semver";
import { codingAgentName } from "./coding-agent-smoke.mjs";
import { execNpmSync } from "../lib/npm-command.mjs";
import { runPublishPreflight } from "./publish-preflight.mjs";
import { resolveRegistryDependencies, stagePublishTarball } from "./publish-stage.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const { values } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		use: { type: "string", multiple: true, default: [] },
	},
});
const dryRun = values["dry-run"];
if (values.use.length > 0 && !dryRun) throw new Error("--use only tries versions; it is allowed only with --dry-run");

function viewPackage(name, version) {
	try {
		const output = execNpmSync(["view", `${name}@${version}`, "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return output.trim() ? JSON.parse(output) : undefined;
	} catch (error) {
		const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
		if (output.includes("E404") || output.includes("404 Not Found")) return undefined;
		throw new Error(`Failed to query ${name}@${version}\n${output}`, { cause: error });
	}
}

function refuse(reason) {
	console.error(`\nNot publishing: ${reason}`);
	process.exit(1);
}

const repoRoot = process.cwd();
const releasePackages = getPublicWorkspacePackages().filter(
	(pkg) => pkg.name !== "@octocodeai/octocode-agentic-testkit",
);
if (releasePackages.length !== 1 || releasePackages[0].name !== codingAgentName)
	refuse(
		`expected ${codingAgentName} as the sole agent release target, found: ${releasePackages.map((pkg) => pkg.name).join(", ")}`,
	);
const [pkg] = releasePackages;
console.log(`Publishing ${pkg.name}@${pkg.version}${dryRun ? " (dry run)" : ""}\n`);

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
if (dirty) {
	if (!dryRun) refuse("the working tree has uncommitted changes. Commit them so the release matches its tag.");
	console.log(`Warning: uncommitted changes (${dirty.split("\n").length} files); a real publish refuses this.`);
}
if (!dryRun) {
	try {
		const user = execNpmSync(["whoami"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		console.log(`npm user: ${user}`);
	} catch {
		refuse("not logged in to npm. Run: npm login");
	}
}
if (viewPackage(pkg.name, pkg.version)) {
	const message = `${pkg.name}@${pkg.version} is already on npm. Bump the version first.`;
	if (!dryRun) refuse(message);
	console.log(`Warning: ${message}`);
}
if (!existsSync(join(pkg.directory, "dist", "bundle", "octocode.js")))
	refuse(`${pkg.directory}/dist is not built. Run: yarn run build`);

const manifest = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
const registry = { ...manifest.octocodeRelease?.registry };
for (const use of values.use) {
	const at = use.lastIndexOf("@");
	const name = use.slice(0, at);
	if (at <= 0 || !Object.hasOwn(registry, name))
		throw new Error(`--use needs a name from octocodeRelease.registry: ${use}`);
	registry[name] = use.slice(at + 1);
}
const { packages: mapping, missing } = resolveRegistryDependencies(registry, viewPackage);
if (missing.length > 0)
	refuse(
		`these dependency versions are not on npm yet: ${missing.join(", ")}. Publish them first, or change octocodeRelease.registry in packages/coding-agent/package.json.`,
	);
for (const [name, entry] of Object.entries(mapping)) console.log(`Dependency: ${name}@${entry.version}`);

const destination = mkdtempSync(join(tmpdir(), "octocode-publish-"));
try {
	const { packed, projectDocs, rewrittenLinks } = stagePublishTarball({
		packageDirectory: pkg.directory,
		packagePath: "packages/coding-agent",
		docsDirectory: join(repoRoot, "docs"),
		mapping,
		destination,
	});
	console.log(
		`\nTarball: ${packed.files.length} files, ${(packed.size / 1048576).toFixed(1)} MB packed, ${(packed.unpackedSize / 1048576).toFixed(1)} MB unpacked; ${projectDocs} project docs included; ${rewrittenLinks} documentation links re-pointed`,
	);

	console.log("\nInstalling the tarball from npm and running a real session...");
	const { failures, warnings } = await runPublishPreflight(packed.path);
	for (const warning of warnings) console.log(`Warning: ${warning}`);
	if (failures.length > 0) refuse(`the installed package failed its checks:\n  ${failures.join("\n  ")}`);
	console.log("Install, session, image worker and native helper checks passed.\n");

	const args = ["publish", packed.path, "--access", "public", "--ignore-scripts"];
	// A prerelease must never become `latest`.
	if (semver.prerelease(pkg.version)) args.push("--tag", "next");
	// npm attests provenance only from a supported CI with an OIDC token, and only for a public repository.
	if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.OCTOCODE_NPM_PROVENANCE !== "0")
		args.push("--provenance");
	if (dryRun) args.push("--dry-run");
	execNpmSync(args, { stdio: "inherit" });
	if (!dryRun) {
		const published = viewPackage(pkg.name, pkg.version);
		if (!published) console.log("Warning: npm does not list the new version yet; it can take a minute.");
		console.log(`\nPublished ${pkg.name}@${pkg.version}. Install with: npm install -g ${pkg.name}`);
	}
} finally {
	rmSync(destination, { force: true, recursive: true });
}
