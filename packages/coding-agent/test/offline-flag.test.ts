import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadModelRuntimeParts } from "../src/core/model-runtime/create.ts";
import { isOfflineModeEnabled, OFFLINE_ENV } from "../src/utils/env-flag.ts";
import { getLatestOctocodeRelease } from "../src/utils/version-check.ts";

const OFFLINE = ["1", "true", "TRUE", "yes", "on", " On "];
const ONLINE = [undefined, "", "0", "false", "False", "off", "no", " 0 ", "maybe"];

const previous = process.env[OFFLINE_ENV];
afterEach(() => {
	if (previous === undefined) delete process.env[OFFLINE_ENV];
	else process.env[OFFLINE_ENV] = previous;
	vi.unstubAllGlobals();
});

function setOffline(value: string | undefined): void {
	if (value === undefined) delete process.env[OFFLINE_ENV];
	else process.env[OFFLINE_ENV] = value;
}

describe("OCTOCODE_OFFLINE", () => {
	it.each(OFFLINE)("%j is offline", (value) => expect(isOfflineModeEnabled({ [OFFLINE_ENV]: value })).toBe(true));
	it.each(ONLINE)("%j is online", (value) => expect(isOfflineModeEnabled({ [OFFLINE_ENV]: value })).toBe(false));

	it.each([
		["0", true],
		["false", true],
		["1", false],
		["on", false],
	])("the version check with %j fetches: %s", async (value, fetches) => {
		setOffline(value);
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const release = await getLatestOctocodeRelease("1.0.0", { retry: false });
		expect(fetchMock.mock.calls.length > 0).toBe(fetches);
		expect(release?.version).toBe(fetches ? "99.0.0" : undefined);
	});

	it.each([
		["0", true],
		["1", false],
	])("the model runtime loaded with %j enables network catalog refreshes: %s", async (value, network) => {
		setOffline(value);
		const parts = await loadModelRuntimeParts({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
		});
		expect(parts.modelNetworkEnabled).toBe(network);
	});
});
