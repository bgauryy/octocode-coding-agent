import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSnapshotSchema, type ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfigSnapshot } from "../../src/octocode/web-daemon/config-status.ts";
import { writeConfigProvider } from "../../src/octocode/web-daemon/provider-write.ts";

let root: string;
let agentDir: string;
const snapshotOf = (): Promise<ConfigSnapshot> =>
	buildConfigSnapshot({ agentDir, piDirs: [], home: root, keychain: null, env: {} });
const options = () => ({ agentDir, piDirs: [], home: root, env: {}, actor: "web:test" });

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-models-"));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("per-provider model choice on the web", () => {
	it("lists a provider's models and starts with none hidden", async () => {
		const row = (await snapshotOf()).providers.find((entry) => entry.provider === "openai");
		expect(row?.modelChoice?.ids.length).toBeGreaterThan(1);
		expect(row?.modelChoice?.hidden).toEqual([]);
	});

	it("saves the hidden list in global settings and reports it back", async () => {
		const ids = (await snapshotOf()).providers.find((entry) => entry.provider === "openai")!.modelChoice!.ids;
		await writeConfigProvider({ action: "set-models", provider: "openai", hidden: [ids[0]] }, options());
		const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		expect(saved.hiddenModels).toEqual({ openai: [ids[0]] });
		const snapshot = await snapshotOf();
		expect(snapshot.providers.find((entry) => entry.provider === "openai")?.modelChoice?.hidden).toEqual([ids[0]]);
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
	});

	it("removes the entry when everything is ticked again and refuses an unknown provider", async () => {
		await writeConfigProvider({ action: "set-models", provider: "openai", hidden: ["gpt-x"] }, options());
		await writeConfigProvider({ action: "set-models", provider: "openai", hidden: [] }, options());
		const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		expect(saved.hiddenModels).toBeUndefined();
		await expect(
			writeConfigProvider({ action: "set-models", provider: "nope-provider", hidden: ["a"] }, options()),
		).rejects.toMatchObject({ status: 404 });
	});
});

describe("provider test route", () => {
	it("refuses an unknown provider and one without a credential, without any request", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const { runProviderTest } = await import("../../src/octocode/web-daemon/provider-test-route.ts");
		const fetch = vi.fn();
		await expect(runProviderTest({ provider: "nope-provider" }, { agentDir, env: {}, fetch })).rejects.toMatchObject({
			status: 404,
		});
		await expect(runProviderTest({ provider: "openai" }, { agentDir, env: {}, fetch })).rejects.toMatchObject({
			status: 409,
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
