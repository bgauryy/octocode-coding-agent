import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { discoverExtensionsInDir } from "../src/core/extensions/loader/discovery.ts";
import { collectResourceFiles } from "../src/core/package-manager/auto-entries.ts";

const extensionCode = `export default function(api) { api.registerCommand("probe", { handler: async () => {} }); }`;

/** SDK discovery and CLI auto-discovery apply one set of rules; each rule is pinned for both entry points. */
describe("extension directory discovery rules", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-ext-rules-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		fs.writeFileSync(path.join(extensionsDir, "visible.ts"), extensionCode);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const names = (paths: string[]) => paths.map((entry) => path.relative(extensionsDir, entry)).sort();
	const discoverers: Array<[string, (dir: string) => string[]]> = [
		["SDK discoverExtensionsInDir", discoverExtensionsInDir],
		["CLI collectResourceFiles(extensions)", (dir) => collectResourceFiles(dir, "extensions")],
	];

	describe.each(discoverers)("%s", (_label, discover) => {
		it("skips dot files and dot directories", () => {
			fs.writeFileSync(path.join(extensionsDir, ".dotfile.ts"), extensionCode);
			fs.mkdirSync(path.join(extensionsDir, ".hidden"));
			fs.writeFileSync(path.join(extensionsDir, ".hidden", "index.ts"), extensionCode);

			expect(names(discover(extensionsDir))).toEqual(["visible.ts"]);
		});

		it("skips node_modules", () => {
			fs.mkdirSync(path.join(extensionsDir, "node_modules"));
			fs.writeFileSync(path.join(extensionsDir, "node_modules", "index.ts"), extensionCode);

			expect(names(discover(extensionsDir))).toEqual(["visible.ts"]);
		});

		it("skips gitignored files and directories", () => {
			fs.writeFileSync(path.join(extensionsDir, ".gitignore"), "ignored/\nscratch.ts\n");
			fs.mkdirSync(path.join(extensionsDir, "ignored"));
			fs.writeFileSync(path.join(extensionsDir, "ignored", "index.ts"), extensionCode);
			fs.writeFileSync(path.join(extensionsDir, "scratch.ts"), extensionCode);

			expect(names(discover(extensionsDir))).toEqual(["visible.ts"]);
		});

		it("skips directories with a plugin or skill marker", () => {
			for (const [dirName, marker] of [
				["skilled", "SKILL.md"],
				["claude-plugin", "plugin.json"],
			] as const) {
				fs.mkdirSync(path.join(extensionsDir, dirName));
				fs.writeFileSync(path.join(extensionsDir, dirName, "index.ts"), extensionCode);
				fs.writeFileSync(path.join(extensionsDir, dirName, marker), "");
			}

			expect(names(discover(extensionsDir))).toEqual(["visible.ts"]);
		});

		it("keeps subdirectory index files", () => {
			fs.mkdirSync(path.join(extensionsDir, "pack"));
			fs.writeFileSync(path.join(extensionsDir, "pack", "index.ts"), extensionCode);

			expect(names(discover(extensionsDir))).toEqual(["pack/index.ts", "visible.ts"]);
		});
	});

	it("loads only the shared-rule extensions through discoverAndLoadExtensions", async () => {
		fs.writeFileSync(path.join(extensionsDir, ".dotfile.ts"), extensionCode);
		fs.writeFileSync(path.join(extensionsDir, ".gitignore"), "ignored/\n");
		fs.mkdirSync(path.join(extensionsDir, "ignored"));
		fs.writeFileSync(path.join(extensionsDir, "ignored", "index.ts"), extensionCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => path.basename(extension.path))).toEqual(["visible.ts"]);
	});
});
