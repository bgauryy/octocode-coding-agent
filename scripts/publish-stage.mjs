import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { execNpmSync } from "./npm-command.mjs";
import { stageRegistryManifest } from "./registry-release.mjs";

/** What only this repository needs: a consumer never reads these, and development specifiers must not leak to npm. */
const DEVELOPMENT_FIELDS = ["devDependencies", "scripts", "overrides", "octocodeRelease"];
/** Where the repository's `docs/` go in the package, beside the package's own docs. */
const PROJECT_DOCS = "docs/project";
/** The bundle's code files; every other `.js` beside them is a launcher (`build-coding-agent.mjs`). */
const BUNDLE_CODE_FILES = new Set(["octocode.js", "db-writer-worker.js"]);
/** Dated reviews, evidence and RFCs: a record of how the project got here, not guidance for someone who installed it. */
const INTERNAL_DOC = /^(?:RFC_.+|.+_(?:REVIEW|AUDIT|VALIDATION|COVERAGE|ASSESSMENT|CONFORMANCE|ROLLOUT))\.md$/;

/**
 * The manifest a consumer installs: development fields gone, and `dependencies` cut down to what stays outside the bundle
 * (`octocodeRelease.runtime` and the keys of `octocodeRelease.registry`). A package without `octocodeRelease` is unchanged.
 */
export function publishedManifest(source) {
	const release = source.octocodeRelease;
	if (!release) return source;
	const runtime = new Set([...(release.runtime ?? []), ...Object.keys(release.registry ?? {})]);
	for (const name of runtime) {
		if (!source.dependencies?.[name]) throw new Error(`octocodeRelease names ${name}, which is not a dependency`);
	}
	const published = structuredClone(source);
	for (const field of DEVELOPMENT_FIELDS) delete published[field];
	published.dependencies = Object.fromEntries(
		Object.entries(source.dependencies).filter(([name]) => runtime.has(name)),
	);
	return published;
}

/** A reviewed mapping for `stageRegistryManifest`, read from npm: the exact version must already be published. */
export function resolveRegistryDependencies(registry, viewPackage) {
	const packages = {};
	const missing = [];
	for (const [name, version] of Object.entries(registry)) {
		const metadata = viewPackage(name, version);
		if (!metadata?.dist?.integrity) {
			missing.push(`${name}@${version}`);
			continue;
		}
		packages[name] = {
			version,
			integrity: metadata.dist.integrity,
			// A package published outside a Git checkout has no gitHead; the integrity still pins its bytes.
			sourceRevision: metadata.gitHead ?? metadata.dist.integrity,
		};
	}
	return { packages, missing };
}

function githubBase(manifest) {
	const url = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
	const match = /github\.com[/:](.+?)(?:\.git)?$/.exec(url ?? "");
	return match ? `https://github.com/${match[1]}` : undefined;
}

function markdownFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "dist" ? [] : markdownFiles(path);
		return entry.name.endsWith(".md") ? [path] : [];
	});
}

/** A function that makes a repository path into its URL at the release tag. */
function releaseUrl(manifest) {
	const base = githubBase(manifest);
	if (!base) throw new Error("package.json needs a GitHub repository URL for its documentation links");
	return (repoPath, anchor) => `${base}/blob/v${manifest.version}/${repoPath}${anchor ? `#${anchor}` : ""}`;
}

function relativeLink(folder, target, anchor) {
	const path = relative(folder, target).split(sep).join("/");
	return `${path.startsWith(".") ? path : `./${path}`}${anchor ? `#${anchor}` : ""}`;
}

const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
/** A link that leaves the file system or stays in the page: an URL scheme, an anchor or an absolute path. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;

/** Rewrite each relative Markdown link in the file; `replace` returns the new target, or undefined to keep the link. */
function rewriteRelativeLinks(file, replace) {
	let rewritten = 0;
	const contents = readFileSync(file, "utf8");
	const updated = contents.replace(MARKDOWN_LINK, (link, target) => {
		if (NOT_RELATIVE.test(target)) return link;
		const [path, anchor] = target.split("#");
		const replacement = replace(path, anchor);
		if (replacement === undefined) return link;
		rewritten++;
		return `](${replacement})`;
	});
	if (updated !== contents) writeFileSync(file, updated);
	return rewritten;
}

/**
 * Copy the repository's `docs/`, without the internal ones, to `docs/project/` in the package. Their links were written for
 * the repository layout, so each one is re-pointed: at the shipped copy when the package has it, otherwise at the release
 * tag on GitHub, which still has the internal ones.
 */
export function stageProjectDocs(docsDirectory, packageDirectory, manifest, packagePath) {
	const url = releaseUrl(manifest);
	const stagedDocs = join(packageDirectory, PROJECT_DOCS);
	cpSync(docsDirectory, stagedDocs, { recursive: true, filter: (from) => !INTERNAL_DOC.test(basename(from)) });
	const files = markdownFiles(stagedDocs);
	for (const file of files) {
		const folder = dirname(file);
		const repoFolder = posix.join("docs", relative(stagedDocs, folder).split(sep).join("/"));
		rewriteRelativeLinks(file, (path, anchor) => {
			const repoPath = posix.normalize(posix.join(repoFolder, path));
			if (repoPath.startsWith("..")) return undefined;
			if (repoPath.startsWith("docs/") && existsSync(resolve(folder, path))) return undefined;
			if (repoPath.startsWith(`${packagePath}/`)) {
				const shipped = join(packageDirectory, repoPath.slice(packagePath.length + 1));
				if (existsSync(shipped)) return relativeLink(folder, shipped, anchor);
			}
			return url(repoPath, anchor);
		});
	}
	return files.length;
}

/**
 * Relative links that leave the published files would break on npm and in the installed docs: re-point them at the shipped
 * project docs when that is the target, otherwise at the release tag on GitHub. `packagePath` is the package's folder in
 * the repository. Links to shipped files stay relative.
 */
export function rewriteOutsideLinks(packageDirectory, manifest, packagePath) {
	const url = releaseUrl(manifest);
	let rewritten = 0;
	for (const file of markdownFiles(packageDirectory)) {
		const folder = dirname(file);
		rewritten += rewriteRelativeLinks(file, (path, anchor) => {
			if (existsSync(resolve(folder, path))) return undefined;
			const inPackage = relative(packageDirectory, resolve(folder, path)).split(sep).join("/");
			const repoPath = posix.normalize(posix.join(packagePath, inPackage));
			if (repoPath.startsWith("..")) return undefined;
			const projectDoc = repoPath.startsWith("docs/") ? join(packageDirectory, PROJECT_DOCS, repoPath.slice(5)) : "";
			return projectDoc && existsSync(projectDoc) ? relativeLink(folder, projectDoc, anchor) : url(repoPath, anchor);
		});
	}
	return rewritten;
}

/** Every reason this package tree must not reach npm; empty when it is fit to publish. */
export function findPackageProblems(packageDirectory) {
	const problems = [];
	const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
	for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
			if (/^(?:file|link|workspace|portal):|^\.{0,2}\//.test(spec)) problems.push(`local dependency ${name}: ${spec}`);
		}
	}
	for (const field of DEVELOPMENT_FIELDS) {
		if (manifest[field]) problems.push(`development field in the manifest: ${field}`);
	}
	for (const required of [
		"LICENSE",
		"README.md",
		PROJECT_DOCS,
		"dist/bundle/octocode.js",
		"dist/bundle/db-writer-worker.js",
		"dist/licenses/THIRD_PARTY_NOTICES.md",
	]) {
		if (!existsSync(join(packageDirectory, required))) problems.push(`missing ${required}`);
	}
	// Installed agents and the npm page read these docs: every relative link must reach a file in the tarball.
	for (const file of markdownFiles(packageDirectory)) {
		for (const [, target] of readFileSync(file, "utf8").matchAll(MARKDOWN_LINK)) {
			const path = target.split("#")[0];
			if (NOT_RELATIVE.test(target) || !path || existsSync(resolve(dirname(file), path))) continue;
			problems.push(`broken documentation link: ${relative(packageDirectory, file).split(sep).join("/")} -> ${target}`);
		}
	}
	if (!existsSync(join(packageDirectory, "dist/native"))) problems.push("missing the native terminal helpers");
	const javascript = (directory) =>
		readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".js"));
	const bundleDirectory = join(packageDirectory, "dist/bundle");
	if (existsSync(bundleDirectory)) {
		if (existsSync(join(bundleDirectory, "chunks"))) problems.push("the bundle has chunks; it must be one file");
		for (const entry of javascript(bundleDirectory)) {
			// Launchers only choose a command; anything larger means code escaped the one bundle file. The database
			// writer's worker is its own file by design (`build-coding-agent.mjs`).
			if (BUNDLE_CODE_FILES.has(entry.name)) continue;
			if (statSync(join(bundleDirectory, entry.name)).size > 1024)
				problems.push(`more than one code file in the bundle: ${entry.name}`);
		}
	}
	const walk = (directory) =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
		);
	for (const file of walk(packageDirectory)) {
		const path = relative(packageDirectory, file).split(sep).join("/");
		if (/(?:^|\/)(?:\.env[^/]*|\.npmrc|\.DS_Store)$|\.map$|\.bun-build$/.test(path))
			problems.push(`stray file: ${path}`);
		if (path.startsWith("src/") || path.startsWith("test/")) problems.push(`source file: ${path}`);
	}
	return problems;
}

function packInto(directory, destination) {
	const packed = JSON.parse(
		execNpmSync(["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
			cwd: directory,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename)
		throw new Error(`Unexpected npm pack result for ${directory}`);
	return { ...packed[0], path: join(destination, packed[0].filename) };
}

/**
 * Pack the working package, swap in the published manifest and outside links, verify the result and repack it. The source
 * tree is not touched, so development keeps its `link:` dependencies.
 */
export function stagePublishTarball({ packageDirectory, packagePath, docsDirectory, mapping, destination }) {
	const scratch = mkdtempSync(join(tmpdir(), "octocode-publish-stage-"));
	try {
		const first = packInto(packageDirectory, scratch);
		execFileSync("tar", ["-xzf", first.path, "-C", scratch]);
		const stagedDirectory = join(scratch, "package");
		const source = JSON.parse(readFileSync(join(stagedDirectory, "package.json"), "utf8"));
		const manifest = stageRegistryManifest(publishedManifest(source), mapping);
		writeFileSync(join(stagedDirectory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		const projectDocs = stageProjectDocs(docsDirectory, stagedDirectory, manifest, packagePath);
		const rewrittenLinks = rewriteOutsideLinks(stagedDirectory, manifest, packagePath);
		const problems = findPackageProblems(stagedDirectory);
		if (problems.length > 0)
			throw new Error(`The package is not fit to publish:\n  ${problems.slice(0, 20).join("\n  ")}`);
		const packed = packInto(stagedDirectory, destination);
		return { manifest, packed, projectDocs, rewrittenLinks };
	} finally {
		rmSync(scratch, { force: true, recursive: true });
	}
}
