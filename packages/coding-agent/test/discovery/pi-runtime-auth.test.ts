import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelRuntimeParts } from "../../src/core/model-runtime/create.ts";
import { createSandbox, type Sandbox, write } from "./fixtures.ts";

/** Pi's models.json and auth.json at runtime: Octocode's files win, Pi's are read only and never written. */
let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const provider = (id: string, baseUrl = "http://localhost:1/v1") => ({
	[id]: { baseUrl, apiKey: "key", api: "openai-completions", models: [{ id: `${id}-model` }] },
});
const load = () =>
	loadModelRuntimeParts({
		authPath: join(sandbox.agentDir, "auth.json"),
		modelsPath: join(sandbox.agentDir, "models.json"),
	});
const piOauth = { type: "oauth", access: "pi-access", refresh: "pi-refresh", expires: 1 };

describe("Pi providers at runtime", () => {
	it("adds a Pi-only provider and keeps Octocode's definition of a shared one whole", async () => {
		write(join(sandbox.agentDir, "models.json"), JSON.stringify({ providers: provider("shared", "http://o.test/v1") }));
		write(
			join(sandbox.piAgentDir, "models.json"),
			JSON.stringify({ providers: { ...provider("shared", "http://pi.test/v1"), ...provider("pi-only") } }),
		);
		const { config, modelsStore } = await load();
		expect([...config.getProviderIds()].sort()).toEqual(["pi-only", "shared"]);
		expect(config.getProvider("shared")?.baseUrl).toBe("http://o.test/v1");
		expect(modelsStore.constructor.name).toBe("FileModelsStore");
	});

	it("loads nothing from Pi when OCTOCODE_HOME is set", async () => {
		write(join(sandbox.piAgentDir, "models.json"), JSON.stringify({ providers: provider("pi-only") }));
		write(join(sandbox.piAgentDir, "auth.json"), JSON.stringify({ "pi-only": { type: "api_key", key: "pi-key" } }));
		vi.stubEnv("OCTOCODE_HOME", join(sandbox.home, "isolated"));
		const home = join(sandbox.home, "isolated", "octocodecode");
		const { config, credentials } = await loadModelRuntimeParts({
			authPath: join(home, "auth.json"),
			modelsPath: join(home, "models.json"),
		});
		expect(config.getProviderIds()).toEqual([]);
		expect(await credentials.read("pi-only")).toBeUndefined();
	});
});

describe("Pi credentials at runtime", () => {
	it("reads a Pi credential only for a provider Octocode has none for, without changing Pi's file", async () => {
		const piAuth = join(sandbox.piAgentDir, "auth.json");
		const piContent = JSON.stringify({
			acme: { type: "api_key", key: "pi-key" },
			both: { type: "api_key", key: "pi-both" },
			secret: { type: "api_key", key: "!echo hidden" },
		});
		write(piAuth, piContent);
		write(join(sandbox.agentDir, "auth.json"), JSON.stringify({ both: { type: "api_key", key: "octo-both" } }));
		const { credentials } = await load();
		expect(await credentials.read("acme")).toEqual({ type: "api_key", key: "pi-key" });
		expect(await credentials.read("both")).toEqual({ type: "api_key", key: "octo-both" });
		expect(await credentials.read("secret")).toBeUndefined();
		expect((await credentials.list()).map((entry) => entry.providerId).sort()).toEqual(["acme", "both"]);
		await credentials.delete("acme");
		expect(readFileSync(piAuth, "utf8")).toBe(piContent);
	});

	it("writes an OAuth refresh of a Pi credential to Octocode's auth.json, not Pi's", async () => {
		const piAuth = join(sandbox.piAgentDir, "auth.json");
		const piContent = JSON.stringify({ acme: piOauth });
		write(piAuth, piContent);
		const { credentials } = await load();
		let seen: unknown;
		await credentials.modify("acme", async (current) => {
			seen = current;
			return { type: "oauth", access: "new-access", refresh: "new-refresh", expires: 2 };
		});
		expect(seen).toEqual(piOauth);
		expect(readFileSync(piAuth, "utf8")).toBe(piContent);
		const octo = JSON.parse(readFileSync(join(sandbox.agentDir, "auth.json"), "utf8"));
		expect(octo.acme).toMatchObject({ access: "new-access", refresh: "new-refresh" });
		expect(await credentials.read("acme")).toMatchObject({ access: "new-access" });
	});
});
