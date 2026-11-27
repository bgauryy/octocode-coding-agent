import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.ts";

describe("Vertex Application Default Credentials file", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "vertex-adc-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	test("is looked for again on every call, so a login after the first check is seen", async () => {
		// The Node modules load asynchronously at import; wait until a call can look at the disk.
		const env = { GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "l" };
		await vi.waitFor(() => {
			mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
			writeFileSync(join(home, ".config", "gcloud", "application_default_credentials.json"), "{}");
			expect(getEnvApiKey("google-vertex", env)).toBe("<authenticated>");
		});
		rmSync(join(home, ".config"), { recursive: true });
		expect(getEnvApiKey("google-vertex", env)).toBeUndefined();
		mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
		writeFileSync(join(home, ".config", "gcloud", "application_default_credentials.json"), "{}");
		expect(getEnvApiKey("google-vertex", env)).toBe("<authenticated>");
	});
});
