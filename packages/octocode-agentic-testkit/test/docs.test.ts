import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { matchers } from "../src/matchers.ts";

/*
 * The package docs stay true to the code: links and anchors resolve, documented imports exist, matchers named in the
 * docs are registered, and no placeholder is left.
 */

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = [
	"README.md",
	"GUIDE.md",
	"REFERENCE.md",
	"MCP-AND-SKILLS.md",
	"CHANGELOG.md",
	"examples/README.md",
].filter((d) => existsSync(join(ROOT, d)));
const PACKAGE = "@octocodeai/octocode-agentic-testkit";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
	exports: Record<string, { source: string }>;
};

const read = (doc: string): string => readFileSync(join(ROOT, doc), "utf8");
const withoutCode = (md: string): string => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
const codeBlocks = (md: string): string[] => [...md.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)].map((m) => m[1]);

/** GitHub's heading anchors: lower case, punctuation dropped, spaces as dashes. */
function anchors(md: string): Set<string> {
	const out = new Set<string>();
	for (const m of md.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6} (.+)$/gm))
		out.add(
			m[1]
				.trim()
				.toLowerCase()
				.replace(/[^\p{L}\p{N} _-]/gu, "")
				.replace(/ /g, "-"),
		);
	return out;
}

describe("package docs", () => {
	it("cover the expected pages", () => {
		expect(DOCS).toEqual(
			expect.arrayContaining(["README.md", "GUIDE.md", "REFERENCE.md", "MCP-AND-SKILLS.md", "CHANGELOG.md"]),
		);
	});

	it("link only to files and headings that exist", () => {
		const broken: string[] = [];
		for (const doc of DOCS) {
			for (const m of withoutCode(read(doc)).matchAll(/\]\(([^)\s]+)\)/g)) {
				const target = m[1];
				if (/^[a-z]+:/.test(target)) continue;
				const [file, anchor] = target.split("#");
				const path = file ? resolve(dirname(join(ROOT, doc)), file) : join(ROOT, doc);
				if (!existsSync(path)) {
					broken.push(`${doc}: ${target} (no file)`);
					continue;
				}
				if (anchor && path.endsWith(".md") && !anchors(readFileSync(path, "utf8")).has(anchor))
					broken.push(`${doc}: ${target} (no heading)`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("import only subpaths the package exports, and names those entries export", async () => {
		const problems: string[] = [];
		for (const doc of DOCS)
			for (const block of codeBlocks(read(doc)))
				for (const m of block.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s+from\s+"([^"]+)"/g)) {
					const [, typeOnly, names, from] = m;
					if (from !== PACKAGE && !from.startsWith(`${PACKAGE}/`)) continue;
					const sub = from === PACKAGE ? "." : `.${from.slice(PACKAGE.length)}`;
					const entry = pkg.exports[sub];
					if (!entry) {
						problems.push(`${doc}: ${from} is not an export`);
						continue;
					}
					if (typeOnly) continue;
					const mod = (await import(join(ROOT, entry.source))) as Record<string, unknown>;
					for (const raw of names.split(",")) {
						const name = raw.trim();
						if (!name || name.startsWith("type ")) continue;
						if (!(name in mod)) problems.push(`${doc}: ${from} has no export ${name}`);
					}
				}
		expect(problems).toEqual([]);
	});

	it("name only registered matchers", () => {
		const known = new Set(Object.keys(matchers));
		const missing = new Set<string>();
		const ours =
			/\.(?:not\.)?(to(?:Have|Keep|Follow|Reflect|NotRetry|Stay|MatchSchema|PassSurface|PassVerifier|ChangeOnly|GrowAtMost)\w*)\(/g;
		for (const doc of DOCS) for (const m of read(doc).matchAll(ours)) if (!known.has(m[1])) missing.add(m[1]);
		// Vitest's own matchers that share a prefix.
		for (const builtin of [
			"toHaveBeenCalled",
			"toHaveBeenCalledTimes",
			"toHaveBeenCalledWith",
			"toHaveLength",
			"toHaveProperty",
		])
			missing.delete(builtin);
		expect([...missing]).toEqual([]);
	});

	it("leave no placeholder or stale pointer", () => {
		for (const doc of DOCS) {
			const text = read(doc);
			expect(text, doc).not.toMatch(/\b(?:FRAMEWORK_SNIPPETS|SETUP_TEXT|IMPORT_MAP|TODO|TBD)\b/);
			expect(text, doc).not.toMatch(/from "\.\.\/src\//);
		}
	});
});
