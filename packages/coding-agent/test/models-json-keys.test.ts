import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { modelsEnvKeyNames, modelsFileHoldsLiteralKey, NO_KEY } from "../src/core/models-json-keys.ts";

/** The key facts bash scrubbing and the startup safety check read from models.json. */
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-models-keys-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, content: string) => {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
};

describe("models.json key facts", () => {
	test("a file with comments, a BOM and trailing commas still yields its key variables and literal keys", () => {
		const path = file(
			"models.json",
			'﻿{\n  // gateway\n  "providers": {\n    "gw": { "apiKey": "$GW_KEY", },\n    "raw": { "apiKey": "sk-literal" },\n  },\n}\n',
		);
		expect(modelsEnvKeyNames(path)).toEqual(["GW_KEY"]);
		expect(modelsFileHoldsLiteralKey(path)).toBe(true);
	});

	test("the local-server marker is no literal key", () => {
		const path = file("models.json", JSON.stringify({ providers: { ollama: { apiKey: NO_KEY } } }));
		expect(modelsFileHoldsLiteralKey(path)).toBe(false);
	});

	test("header values name variables but are no literal keys", () => {
		const path = file(
			"models.json",
			JSON.stringify({ providers: { gw: { headers: { "x-org": "acme", "x-token": "$GW_TOKEN" } } } }),
		);
		expect(modelsEnvKeyNames(path)).toEqual(["GW_TOKEN"]);
		expect(modelsFileHoldsLiteralKey(path)).toBe(false);
	});
});
