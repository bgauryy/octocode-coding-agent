import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { onCredentialChange } from "../../src/core/model-runtime/credential-operations.ts";
import { providerHealth } from "../../src/octocode/subagents/provider-health.ts";

const INVALID_GRANT = '401 {"error":"invalid_grant","error_description":"Refresh token has been revoked"}';

let dir: string;
let runtime: ModelRuntime;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "octocode-credential-change-"));
	writeFileSync(join(dir, "auth.json"), "{}");
	runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("credential changes", () => {
	it("are announced per provider for a runtime key, an import and a logout", async () => {
		const changed: string[] = [];
		const stop = onCredentialChange((provider) => changed.push(provider));
		await runtime.setRuntimeApiKey("groq", "k1");
		await runtime.importCredential("cerebras", { type: "api_key", key: "k2" });
		await runtime.logout("cerebras");
		await runtime.removeRuntimeApiKey("groq");
		stop();
		await runtime.setRuntimeApiKey("groq", "k3");
		expect(changed).toEqual(["groq", "cerebras", "cerebras", "groq"]);
	});

	it("clear a provider's saved refusal so routing offers it again, and no other provider's", async () => {
		providerHealth.noteRun("groq/llama", INVALID_GRANT);
		providerHealth.noteRun("cerebras/zai", INVALID_GRANT);
		expect(providerHealth.refused("groq")).toBe(true);
		await runtime.importCredential("groq", { type: "api_key", key: "fresh" });
		expect(providerHealth.refused("groq")).toBe(false);
		expect(providerHealth.refused("cerebras")).toBe(true);
		providerHealth.credentialChanged("cerebras");
	});
});
