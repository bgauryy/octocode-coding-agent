import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { HOST_MODULE_SPECIFIERS, HOST_PROVIDED_PACKAGE_NAMES } from "../src/core/extensions/host-modules.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";
import type { DefaultPackageManager, PathMetadata, ResolvedPaths } from "../src/core/package-manager.ts";
import { ExtensionSetLoader } from "../src/core/resource-loader/extension-loading.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const empty = (): ResolvedPaths => ({ extensions: [], skills: [], prompts: [], themes: [] });

describe("pre-trust extension selection", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-precedence-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("uses the settings metadata first when a path is also supplied by --extension, like the final pass", async () => {
		const packageRoot = path.join(dir, "pkg");
		fs.mkdirSync(packageRoot);
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ dependencies: { typebox: "*" } }));
		const extension = path.join(packageRoot, "index.ts");
		fs.writeFileSync(extension, "export default function () {}");

		const packageMetadata: PathMetadata = {
			source: "npm:pkg",
			scope: "user",
			origin: "package",
			packageRoot,
		};
		const cliMetadata: PathMetadata = { source: "cli", scope: "temporary", origin: "top-level" };
		const packageManager = {
			resolve: async () => ({
				...empty(),
				extensions: [{ path: extension, enabled: true, metadata: packageMetadata }],
			}),
			resolveExtensionSources: async () => ({
				...empty(),
				extensions: [{ path: extension, enabled: true, metadata: cliMetadata }],
			}),
		} as unknown as DefaultPackageManager;

		const loader = new ExtensionSetLoader({
			cwd: dir,
			agentDir: path.join(dir, "agent"),
			settingsManager: {} as SettingsManager,
			eventBus: createEventBus(),
			packageManager,
			additionalExtensionPaths: [extension],
			extensionFactories: [],
			nativeFeatures: false,
			builtinExtensions: new Map(),
			noExtensions: false,
			disabledBuiltinExtensions: new Set(),
		});

		const result = await loader.loadCurrentExtensionSet();

		expect(result.errors).toEqual([]);
		expect(result.warnings?.map((warning) => warning.path)).toEqual([path.join(packageRoot, "package.json")]);
	});
});

describe("host-provided modules", () => {
	it("lists exactly the specifiers that VIRTUAL_MODULES supplies", () => {
		expect(Object.keys(VIRTUAL_MODULES).sort()).toEqual([...HOST_MODULE_SPECIFIERS].sort());
	});

	it("derives the host-provided package names from the specifiers", () => {
		expect([...HOST_PROVIDED_PACKAGE_NAMES].sort()).toEqual([
			"@octocodeai/octocode-agent-core",
			"@octocodeai/octocode-ai",
			"@octocodeai/octocode-tui",
			"@octocodeai/octocodecode",
			"@sinclair/typebox",
			"typebox",
		]);
	});
});
