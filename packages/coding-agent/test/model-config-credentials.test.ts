import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

describe("models.json baseUrl credentials", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-model-config-credentials-"));
		file = join(dir, "models.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const model = (extra: Record<string, unknown> = {}) => ({ id: "m1", ...extra });
	const load = async (providers: unknown) => {
		writeFileSync(file, JSON.stringify({ providers }));
		return ModelConfig.load(file);
	};

	it.each([
		["user name and password", "https://user:secret@host.example/v1"],
		["user name only", "https://tokenvalue@host.example/v1"],
		["key query parameter", "https://host.example/v1?key=abc"],
		["api_key query parameter", "https://host.example/v1?api_key=abc"],
		["camelCase token parameter", "https://host.example/v1?accessToken=abc"],
	])("refuses a provider baseUrl with a %s, naming the field and not the value", async (_name, baseUrl) => {
		const config = await load({ acme: { baseUrl, api: "openai-completions", apiKey: "k", models: [model()] } });

		expect(config.getProvider("acme")).toBeUndefined();
		const error = config.getError() ?? "";
		expect(error).toContain("providers.acme.baseUrl");
		expect(error).toContain(file);
		expect(error).not.toContain("secret");
		expect(error).not.toContain("abc");
		expect(error).not.toContain("tokenvalue");
	});

	it("refuses a model baseUrl with credentials, naming the provider and model field", async () => {
		const config = await load({
			acme: {
				baseUrl: "https://host.example/v1",
				api: "openai-completions",
				apiKey: "k",
				models: [model({ baseUrl: "https://user:secret@other.example/v1?key=abc" })],
			},
		});

		expect(config.getError()).toContain("providers.acme.models[m1].baseUrl");
		expect(config.getError()).not.toContain("secret");
		expect(config.getError()).not.toContain("abc");
	});

	it("accepts a baseUrl without credentials, including non-secret query parameters", async () => {
		const config = await load({
			acme: {
				baseUrl: "https://host.example/openai/deployments/d?api-version=2024-10-21",
				api: "openai-completions",
				apiKey: "k",
				models: [model()],
			},
		});

		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("acme")).toBeDefined();
	});
});
