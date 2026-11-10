import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { credentialRead } from "../../src/octocode/permission/credential-store.ts";
import { tmp } from "./helpers.ts";

/** Synthetic files in a temp home only: no test reads a real credential file. */
const saved = { ...process.env };
let home: string;
let agent: string;

beforeEach(() => {
	home = fs.realpathSync(tmp("octocode-cred-files-"));
	agent = path.join(home, "agent-dir");
	fs.mkdirSync(agent);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.OCTOCODE_CODING_AGENT_DIR = agent;
	delete process.env.OCTOCODE_HOME;
});

afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

const models = (apiKey: string) =>
	JSON.stringify({ providers: { custom: { baseUrl: "http://localhost:1/v1", apiKey, models: [{ id: "m" }] } } });

describe("credential reads of models.json", () => {
	it("asks for a models.json that holds a literal apiKey", () => {
		fs.writeFileSync(path.join(agent, "models.json"), models("sk-synthetic-literal"));
		const cwd = tmp();
		expect(credentialRead("bash", { command: `cat ${agent}/models.json` }, cwd)).toBeDefined();
		expect(credentialRead("bash", { command: "cat models.json" }, agent)).toBeDefined();
		expect(
			credentialRead("mcp__octocode__localFetch", { queries: [{ path: path.join(agent, "models.json") }] }, cwd),
		).toBeDefined();
	});

	it.each(["$CUSTOM_KEY", "${CUSTOM_KEY}", "!pass show custom"])(
		"does not ask when apiKey is a reference: %s",
		(value) => {
			fs.writeFileSync(path.join(agent, "models.json"), models(value));
			expect(credentialRead("bash", { command: `cat ${agent}/models.json` }, tmp())).toBeUndefined();
		},
	);
});

describe("credential reads of other tools' files", () => {
	it.each([".aws/credentials", ".netrc", ".config/gh/hosts.yml", ".docker/config.json"])("asks for ~/%s", (file) => {
		const full = path.join(home, file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, "x");
		expect(credentialRead("bash", { command: `cat ~/${file}` }, tmp())).toBeDefined();
		expect(credentialRead("bash", { command: `cat ${full}` }, tmp())).toBeDefined();
	});

	it("leaves an ordinary dotfile alone", () => {
		expect(credentialRead("bash", { command: "cat ~/.zshrc" }, tmp())).toBeUndefined();
	});
});

describe("startup warnings for key files", () => {
	it.skipIf(process.platform === "win32")(
		"warns about a loose models.json that holds a literal apiKey only",
		async () => {
			const file = path.join(agent, "models.json");
			const options = {
				cwd: home,
				agentDir: agent,
				resourceLoaderOptions: {
					disabledFeatures: ["mcp", "llama.cpp"],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			};
			fs.writeFileSync(file, models("$CUSTOM_KEY"), { mode: 0o644 });
			fs.chmodSync(file, 0o644);
			expect(
				(await createAgentSessionServices(options)).diagnostics.some((entry) => entry.message.includes(file)),
			).toBe(false);
			fs.writeFileSync(file, models("sk-synthetic-literal"));
			const { diagnostics } = await createAgentSessionServices(options);
			expect(diagnostics.some((entry) => entry.message.includes(file) && entry.message.includes("chmod 600"))).toBe(
				true,
			);
		},
	);
});
