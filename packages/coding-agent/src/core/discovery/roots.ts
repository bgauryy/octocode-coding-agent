import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { ConfigItem, ConfigKind, ConfigScope, DiscoverInput, Product, Provenance } from "./types.ts";

/** Pi's project folder. */
export const PI_PROJECT_DIR_NAME = ".pi";

/** A folder that holds `skills/`, `prompts/`, `themes/`, `SYSTEM.md` and the other named files of one product and scope. */
export interface ConfigRoot {
	product: Product;
	scope: ConfigScope;
	origin: string;
	dir: string;
}

/**
 * The roots in the order a product's own files outrank the other's at the same scope: Octocode's project folder,
 * Pi's project folder, Octocode's global directory, then Pi's global roots. Project roots only exist where project
 * configuration may load (a trusted folder, or `includeUntrusted` for display); Pi's project folder follows Pi compatibility.
 */
export function configRoots(input: DiscoverInput): ConfigRoot[] {
	const roots: ConfigRoot[] = [];
	if (input.projectTrusted || input.includeUntrusted) {
		roots.push({ product: "octocode", scope: "project", origin: "octocode", dir: join(input.cwd, CONFIG_DIR_NAME) });
		if (input.piRoots.length > 0) {
			roots.push({ product: "pi", scope: "project", origin: "pi", dir: join(input.cwd, PI_PROJECT_DIR_NAME) });
		}
	}
	roots.push({ product: "octocode", scope: "global", origin: "octocode", dir: input.agentDir });
	for (const dir of input.piRoots) roots.push({ product: "pi", scope: "global", origin: "pi", dir });
	return roots;
}

/** Build one item. An untrusted project item is marked as such and never loads. */
export function makeItem(
	kind: ConfigKind,
	name: string,
	root: Pick<ConfigRoot, "product" | "scope" | "origin">,
	path: string,
	input: DiscoverInput,
	extra: Partial<Provenance> = {},
): ConfigItem {
	const untrusted = root.scope === "project" && !input.projectTrusted;
	const notLoaded = extra.notLoaded ?? (untrusted ? "untrusted" : undefined);
	return {
		kind,
		name,
		provenance: {
			product: root.product,
			scope: root.scope,
			origin: root.origin,
			path,
			...extra,
			...(notLoaded ? { notLoaded } : {}),
		},
		loaded: notLoaded === undefined,
		diagnostics: [],
	};
}

/** What a skill is called: its front matter `name`, else its folder (`SKILL.md`) or its own file name. */
export function skillName(file: string): string {
	const fallback = basename(file) === "SKILL.md" ? basename(dirname(file)) : basename(file, ".md");
	try {
		const { frontmatter } = parseFrontmatter<{ name?: unknown }>(readFileSync(file, "utf-8"));
		return typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : fallback;
	} catch {
		return fallback;
	}
}

/** What a theme is called: the `name` in its JSON, else its file name. */
export function themeName(file: string): string {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as { name?: unknown };
		return typeof parsed.name === "string" && parsed.name ? parsed.name : basename(file, ".json");
	} catch {
		return basename(file, ".json");
	}
}
