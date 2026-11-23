import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const NODE_MODULES = "/node_modules/";
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/**
 * The nearest folder at or above `directory` whose package.json names a package, or undefined; memoized per folder. A
 * nameless one (`{"type": "module"}` in a build folder) only sets the module format.
 */
function manifestDirectory(directory, cache) {
	if (cache.has(directory)) return cache.get(directory);
	const manifest = join(directory, "package.json");
	const parent = dirname(directory);
	const found =
		existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name
			? directory
			: parent === directory
				? undefined
				: manifestDirectory(parent, cache);
	cache.set(directory, found);
	return found;
}

/**
 * The package directory that holds a bundled module, or undefined for repository sources and virtual modules. An
 * installed package sits under `node_modules`; a `link:` dependency resolves to its real folder outside the repository
 * (the sandbox library's checkout), whose nearest package.json names it.
 */
function packageDirectoryOf(moduleId, repoRoot, cache) {
	const id = moduleId.replaceAll("\\", "/");
	if (id.startsWith("\0")) return undefined;
	const start = id.lastIndexOf(NODE_MODULES);
	if (start >= 0) {
		const parts = id.slice(start + NODE_MODULES.length).split("/");
		const length = parts[0].startsWith("@") ? 2 : 1;
		return id.slice(0, start + NODE_MODULES.length) + parts.slice(0, length).join("/");
	}
	const fromRoot = relative(repoRoot, moduleId);
	const outside = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
	return isAbsolute(moduleId) && outside ? manifestDirectory(dirname(moduleId), cache) : undefined;
}

function licenseOf(manifest) {
	if (typeof manifest.license === "string") return manifest.license;
	if (typeof manifest.license?.type === "string") return manifest.license.type;
	return "see the package's own documentation";
}

/**
 * The license text of every third-party package compiled into the bundle. Minifying removes their license comments, so
 * this is what carries their notices. `moduleIds` come from the bundler, so it lists exactly the code that ships;
 * modules under `repoRoot` outside `node_modules` are this repository's own sources.
 */
export function renderThirdPartyNotices(moduleIds, repoRoot) {
	const cache = new Map();
	const directories = new Set(moduleIds.map((id) => packageDirectoryOf(id, repoRoot, cache)).filter(Boolean));
	const entries = [...directories]
		.flatMap((directory) => {
			const manifestPath = join(directory, "package.json");
			if (!existsSync(manifestPath)) return [];
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (!manifest.name) return [];
			const texts = readdirSync(directory)
				.filter((name) => LICENSE_FILE.test(name))
				.sort()
				.map((name) => readFileSync(join(directory, name), "utf8").trim());
			return [{ id: `${manifest.name}@${manifest.version}`, license: licenseOf(manifest), texts }];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const sections = entries.map(({ id, license, texts }) =>
		[`## ${id}`, `License: ${license}`, ...texts.map((text) => `\`\`\`text\n${text}\n\`\`\``)].join("\n\n"),
	);
	return {
		count: entries.length,
		text: `# Third-party notices\n\nPackages compiled into this package's bundle.\n\n${sections.join("\n\n")}\n`,
	};
}
