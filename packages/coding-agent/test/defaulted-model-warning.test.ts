import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { defaultedModelWarning } from "../src/main/defaulted-model-warning.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("defaultedModelWarning", () => {
	it("warns headless runs about a custom model with defaulted fields, and not the interactive mode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-defaulted-warning-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"warn-a": {
						baseUrl: "http://localhost:1/v1",
						api: "openai-completions",
						apiKey: "k",
						models: [{ id: "local" }],
					},
				},
			}),
		);
		await composeModelProvider("warn-a", undefined, await ModelConfig.load(path), undefined);
		const model = { provider: "warn-a", id: "local" };
		const warning = defaultedModelWarning(model, false);
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain("contextWindow");
		expect(defaultedModelWarning(model, true)).toBeUndefined();
		expect(defaultedModelWarning({ provider: "warn-a", id: "other" }, false)).toBeUndefined();
		expect(defaultedModelWarning(undefined, false)).toBeUndefined();
	});
});
