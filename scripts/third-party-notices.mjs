import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NODE_MODULES = "/node_modules/";
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** The installed package directory that holds a bundled module, or undefined for repository sources and virtual modules. */
function packageDirectoryOf(moduleId) {
	const id = moduleId.replaceAll("\\", "/");
	const start = id.lastIndexOf(NODE_MODULES);
	if (id.startsWith("\0") || start < 0) return undefined;
	const parts = id.slice(start + NODE_MODULES.length).split("/");
	const length = parts[0].startsWith("@") ? 2 : 1;
	return id.slice(0, start + NODE_MODULES.length) + parts.slice(0, length).join("/");
}

function licenseOf(manifest) {
	if (typeof manifest.license === "string") return manifest.license;
	if (typeof manifest.license?.type === "string") return manifest.license.type;
	return "see the package's own documentation";
}

/**
 * The license text of every third-party package compiled into the bundle. Minifying removes their license comments, so
 * this is what carries their notices. `moduleIds` come from the bundler, so it lists exactly the code that ships.
 */
export function renderThirdPartyNotices(moduleIds) {
	const directories = new Set(moduleIds.map(packageDirectoryOf).filter(Boolean));
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
