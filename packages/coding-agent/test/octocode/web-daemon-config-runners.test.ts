import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerListSchema } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigAuditEntry } from "../../../db/src/api.ts";
import { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";
import { actRunners, listRunnerRows } from "../../src/octocode/web-daemon/runner-config.ts";

let root: string;
let agentDir: string;
let bin: string;
const audits: ConfigAuditEntry[] = [];

const settings = () => {
	try {
		return JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	} catch {
		return {};
	}
};
const env = () => ({ PATH: bin, HOME: root }) as NodeJS.ProcessEnv;
const options = () => ({
	agentDir,
	env: env(),
	actor: "web:test",
	audit: (entry: ConfigAuditEntry) => audits.push(entry),
});
const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error,
	);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-runners-"));
	agentDir = path.join(root, "agent");
	bin = path.join(root, "bin");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(bin);
	audits.length = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("web external agents", () => {
	it("lists every known runner from detection alone, valid against the contract", () => {
		fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
		const list = listRunnerRows(options());
		expect(Value.Check(RunnerListSchema, list)).toBe(true);
		expect(list.runners.map((row) => row.id)).toEqual(
			expect.arrayContaining(["claude-code", "codex", "cursor", "gemini", "opencode"]),
		);
		const codex = list.runners.find((row) => row.id === "codex")!;
		expect(codex.cli.installed).toBe(true);
		expect(codex.signIn.state).toBe("unchecked");
		expect(codex.connected).toBe(false);
		expect(codex.enabled).toBe(false);
		expect(list.runners.find((row) => row.id === "gemini")!.cli.installed).toBe(false);
	});

	it("enables and disables one runner through the same settings as /providers", async () => {
		let list = await actRunners({ action: "set-enabled", id: "codex", enabled: true }, options());
		expect(settings()).toMatchObject({ externalAgents: true, enabledExternalAgents: ["codex"] });
		expect(list.tasksEnabled).toBe(true);
		expect(list.runners.find((row) => row.id === "codex")!.enabled).toBe(true);
		expect(list.runners.find((row) => row.id === "gemini")!.enabled).toBe(false);
		list = await actRunners({ action: "set-enabled", id: "codex", enabled: false }, options());
		expect(settings().enabledExternalAgents).toEqual([]);
		expect(list.runners.find((row) => row.id === "codex")!.enabled).toBe(false);
		expect(audits.map((entry) => [entry.action, entry.outcome])).toEqual([
			["runner.enable", "ok"],
			["runner.disable", "ok"],
		]);
	});

	it("pauses and resumes every runner", async () => {
		await actRunners({ action: "set-enabled", id: "codex", enabled: true }, options());
		const paused = await actRunners({ action: "set-tasks", enabled: false }, options());
		expect(paused.tasksEnabled).toBe(false);
		expect(paused.runners.every((row) => !row.enabled)).toBe(true);
		const resumed = await actRunners({ action: "set-tasks", enabled: true }, options());
		expect(resumed.runners.find((row) => row.id === "codex")!.enabled).toBe(true);
	});

	it("refuses an unknown runner and a settings file that did not parse, changing nothing", async () => {
		const unknown = await refusal(actRunners({ action: "set-enabled", id: "nope", enabled: true }, options()));
		expect(unknown).toBeInstanceOf(ConfigWriteError);
		expect((unknown as ConfigWriteError).status).toBe(404);
		fs.writeFileSync(path.join(agentDir, "settings.json"), "{ not json");
		const invalid = await refusal(actRunners({ action: "set-tasks", enabled: true }, options()));
		expect((invalid as ConfigWriteError).status).toBe(409);
		expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe("{ not json");
	});

	it("checks a runner with its own status command and reports the sign-in", async () => {
		fs.writeFileSync(
			path.join(bin, "claude"),
			`#!/bin/sh\necho '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'\n`,
			{ mode: 0o755 },
		);
		const list = await actRunners({ action: "check", id: "claude-code" }, options());
		const claude = list.runners.find((row) => row.id === "claude-code")!;
		expect(claude.signIn).toMatchObject({ state: "signed-in", method: "claude.ai", billing: "plan" });
	});
});
