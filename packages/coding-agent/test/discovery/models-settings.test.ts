import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { ModelConfig } from "../../src/core/model-config.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createSandbox, type Sandbox, write } from "./fixtures.ts";

/** Pi files an Octocode session reads: set only HOME, because an explicit OCTOCODE_HOME turns the Pi roots off. */
let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const provider = (id: string, baseUrl = "http://localhost:1/v1") =>
	JSON.stringify({
		providers: { [id]: { baseUrl, apiKey: "key", api: "openai-completions", models: [{ id: `${id}-model` }] } },
	});

const cli = resolve(__dirname, "../../src/cli.ts");
const resolver = pathToFileURL(resolve(__dirname, "../../scripts/source-resolver.ts")).href;
function listModels(env: Record<string, string>): string {
	return execFileSync(process.execPath, ["--import", resolver, cli, "--list-models"], {
		cwd: sandbox.cwd,
		env: { PATH: process.env.PATH ?? "", HOME: sandbox.home, USERPROFILE: sandbox.home, ...env },
		encoding: "utf8",
	});
}

describe("models.json through discovery", () => {
	it("lists a Pi provider in --list-models, and not when an explicit Octocode home isolates Pi", () => {
		write(join(sandbox.piAgentDir, "models.json"), provider("acme-pi"));
		expect(listModels({})).toContain("acme-pi-model");
		expect(listModels({ OCTOCODE_HOME: join(sandbox.home, "isolated") })).not.toContain("acme-pi");
	});

	it("reads Octocode's file first: its provider wins a clash, a Pi-only provider is added", async () => {
		write(join(sandbox.agentDir, "models.json"), provider("shared", "http://octocode.test/v1"));
		write(join(sandbox.piAgentDir, "models.json"), provider("shared", "http://pi.test/v1"));
		write(join(sandbox.home, ".pi", "models.json"), provider("legacy-root"));
		const config = await ModelConfig.load(join(sandbox.agentDir, "models.json"));
		expect([...config.getProviderIds()].sort()).toEqual(["legacy-root", "shared"]);
		const files = configDiscovery
			.discover("model", discoveryInput({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, projectTrusted: false }))
			.map((item) => [item.provenance.product, item.loaded]);
		expect(files).toEqual([
			["octocode", true],
			["pi", true],
			["pi", true],
		]);
	});
});

describe("settings through discovery", () => {
	const create = (projectTrusted: boolean) => SettingsManager.create(sandbox.cwd, sandbox.agentDir, { projectTrusted });
	const piGlobal = () => join(sandbox.piAgentDir, "settings.json");
	const piProject = () => join(sandbox.cwd, ".pi", "settings.json");

	it("applies Pi global, Pi project, Octocode global and Octocode project in that order of precedence", () => {
		write(piGlobal(), JSON.stringify({ theme: "pi-global", hideThinkingBlock: true, quietStartup: true }));
		write(piProject(), JSON.stringify({ theme: "pi-project", hideThinkingBlock: false }));
		write(join(sandbox.agentDir, "settings.json"), JSON.stringify({ theme: "octocode-global" }));
		expect(create(false).getSettings()).toMatchObject({ theme: "octocode-global", hideThinkingBlock: true });
		expect(create(true).getSettings()).toMatchObject({
			theme: "octocode-global",
			hideThinkingBlock: false,
			quietStartup: true,
		});
		write(join(sandbox.cwd, ".octocode", "settings.json"), JSON.stringify({ theme: "octocode-project" }));
		expect(create(true).getSettings().theme).toBe("octocode-project");
		expect(create(false).getSettings().theme).toBe("octocode-global");
	});

	it("does not read the project .pi/settings.json of an untrusted folder, and reads it once trusted", () => {
		write(piProject(), JSON.stringify({ theme: "pi-project" }));
		const manager = create(false);
		expect(manager.getSettings().theme).toBeUndefined();
		manager.setProjectTrusted(true);
		expect(manager.getSettings().theme).toBe("pi-project");
		manager.setProjectTrusted(false);
		expect(manager.getSettings().theme).toBeUndefined();
	});

	it("never copies a Pi value into an Octocode file when settings are saved", async () => {
		write(
			piGlobal(),
			JSON.stringify({
				theme: "pi-theme",
				defaultProvider: "pi-provider",
				// An object the Octocode setter below rewrites as a whole.
				modelThinkingLevels: { "pi/model": "high" },
				terminal: { showImages: false },
				packages: ["npm:pi-only"],
			}),
		);
		write(piProject(), JSON.stringify({ hideThinkingBlock: true, terminal: { clearOnShrink: true } }));
		const manager = create(true);
		expect(manager.getSettings()).toMatchObject({ theme: "pi-theme", terminal: { showImages: false } });

		manager.setDefaultThinkingLevel("low");
		manager.setModelThinkingLevel("octocode", "model", "medium");
		manager.setShowImages(true);
		manager.setProjectPackages([]);
		await manager.flush();

		const saved = JSON.parse(readFileSync(join(sandbox.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(saved).toMatchObject({ defaultThinkingLevel: "low", terminal: { showImages: true } });
		expect(JSON.stringify(saved)).not.toMatch(/pi-theme|pi-provider|pi\/model|pi-only|clearOnShrink|hideThinkingBlock/);
		expect(saved.modelThinkingLevels).toEqual({ "octocode/model": "medium" });
		// The merged view still carries the Pi values, and the Pi files are untouched.
		expect(manager.getSettings()).toMatchObject({
			theme: "pi-theme",
			terminal: { showImages: true, clearOnShrink: true },
		});
		expect(JSON.parse(readFileSync(piGlobal(), "utf8")).theme).toBe("pi-theme");
		expect(JSON.parse(readFileSync(join(sandbox.cwd, ".octocode", "settings.json"), "utf8"))).toEqual({ packages: [] });
	});

	it("reports a Pi settings file that does not parse and still loads and saves Octocode's own", async () => {
		write(piGlobal(), "{ not json");
		write(join(sandbox.agentDir, "settings.json"), JSON.stringify({ theme: "mine" }));
		const manager = create(false);
		expect(manager.getSettings().theme).toBe("mine");
		expect(manager.drainErrors()).toEqual([]);
		expect(manager.drainWarnings().map((warning) => warning.message)).toEqual([
			expect.stringContaining("Pi settings were not read"),
		]);
		manager.setDefaultThinkingLevel("low");
		await manager.flush();
		expect(JSON.parse(readFileSync(join(sandbox.agentDir, "settings.json"), "utf8"))).toEqual({
			theme: "mine",
			defaultThinkingLevel: "low",
		});
	});
});
