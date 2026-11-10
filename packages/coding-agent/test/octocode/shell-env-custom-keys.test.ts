import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getShellEnv, setShellKeepsProviderKeys } from "../../src/utils/shell.ts";
import { tmp } from "./helpers.ts";

const saved = { ...process.env };

beforeEach(() => {
	const agent = fs.realpathSync(tmp("octocode-shell-env-"));
	process.env.OCTOCODE_CODING_AGENT_DIR = agent;
	fs.writeFileSync(
		path.join(agent, "models.json"),
		JSON.stringify({
			providers: {
				a: { apiKey: "$ACME_API_KEY", models: [{ id: "m" }] },
				b: { apiKey: "${BETA_TOKEN}", models: [{ id: "m" }] },
				c: { apiKey: "!pass show c", models: [{ id: "m" }] },
			},
		}),
	);
	process.env.ACME_API_KEY = "synthetic-a";
	process.env.BETA_TOKEN = "synthetic-b";
	process.env.UNRELATED_SETTING = "kept";
});

afterEach(() => {
	setShellKeepsProviderKeys(false);
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

describe("getShellEnv with custom providers", () => {
	it("drops the variables models.json apiKey values name", () => {
		const env = getShellEnv();
		expect(env.ACME_API_KEY).toBeUndefined();
		expect(env.BETA_TOKEN).toBeUndefined();
		expect(env.UNRELATED_SETTING).toBe("kept");
	});

	it("keeps them when bash.inheritProviderKeys is on", () => {
		setShellKeepsProviderKeys(true);
		const env = getShellEnv();
		expect(env.ACME_API_KEY).toBe("synthetic-a");
		expect(env.BETA_TOKEN).toBe("synthetic-b");
	});
});
