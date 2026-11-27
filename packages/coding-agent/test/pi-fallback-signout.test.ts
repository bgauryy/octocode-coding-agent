import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { providerSourceGate } from "../src/core/provider-sources/index.ts";

let home: string;
let agentDir: string;
let piAuth: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-pi-signout-"));
	agentDir = join(home, ".octocode", "octocodecode");
	piAuth = join(home, ".pi", "agent", "auth.json");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	vi.stubEnv("CEREBRAS_API_KEY", "");
	providerSourceGate.set({});
	mkdirSync(dirname(piAuth), { recursive: true });
	writeFileSync(piAuth, JSON.stringify({ cerebras: { type: "api_key", key: "pi-key" } }));
});
afterEach(() => {
	providerSourceGate.set({});
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

const createRuntime = () =>
	ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
const configured = (runtime: ModelRuntime) => runtime.getProviderAuthStatus("cerebras").configured;

describe("sign-out of a Pi-only credential", () => {
	it("leaves the provider unconfigured, keeps Pi's file untouched, and a new key clears the marker", async () => {
		const before = readFileSync(piAuth);
		const runtime = await createRuntime();
		expect(configured(runtime)).toBe(true);
		expect(runtime.getProviderAuthStatus("cerebras")).toMatchObject({
			source: "stored",
			label: "saved credential in ~/.pi/agent/auth.json",
		});

		await runtime.logout("cerebras");
		expect(configured(runtime)).toBe(false);
		expect(readFileSync(piAuth).equals(before)).toBe(true);
		expect((await createRuntime()).getProviderAuthStatus("cerebras").configured).toBe(false);

		vi.stubEnv("CEREBRAS_API_KEY", "env-key");
		expect(configured(await createRuntime())).toBe(true);
		vi.stubEnv("CEREBRAS_API_KEY", "");

		await runtime.importCredential("cerebras", { type: "api_key", key: "new-key" });
		expect(configured(runtime)).toBe(true);
		expect(runtime.getProviderAuthStatus("cerebras").label).toBe("auth.json");
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).cerebras).toEqual({
			type: "api_key",
			key: "new-key",
		});
		expect(readFileSync(piAuth).equals(before)).toBe(true);
	});
});
