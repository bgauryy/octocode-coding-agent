import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { sensitiveReason } from "../../src/configuration/sensitive.ts";
import { registerConfigurationTool } from "../../src/octocode/native/tools/configuration/tool.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { configuration, globalSettingsFile, projectSettingsFile, readJson } from "../configuration/helpers.ts";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

function setup(mode: PermissionMode = "workspace", options: { isSubagent?: boolean; trusted?: boolean } = {}) {
	const fake = fakeHost();
	const permission = fakePermission(mode, { api: fake.api });
	const noted = vi.spyOn(permission, "noted");
	const trusted = options.trusted ?? true;
	registerConfigurationTool(fake.api, {
		permission,
		isSubagent: options.isSubagent ?? false,
		catalogFor: () => configuration(sandbox, { trusted }),
	});
	const run = async (params: Record<string, unknown>, ui: { confirms?: boolean[]; hasUI?: boolean } = {}) => {
		const ctx = Object.assign(
			fakeCtx({ cwd: sandbox.cwd, hasUI: ui.hasUI ?? true, ui: { confirms: ui.confirms ?? [] } }),
			{
				isProjectTrusted: () => trusted,
			},
		);
		const confirm = vi.spyOn(ctx.ui, "confirm");
		const result = await fake.tools.get("configuration").execute("call", params, undefined, undefined, ctx);
		return { text: result.content[0].text as string, confirm, asked: ui.confirms ?? [] };
	};
	return { run, noted, tools: fake.tools };
}

describe("configuration tool approval", () => {
	it("writes a setting after the user approves and shows key, scope, file and before -> after", async () => {
		const { run, noted } = setup();
		const { text, confirm } = await run({ op: "set", id: "retry.maxRetries", value: 5 }, { confirms: [true] });
		expect(readJson(globalSettingsFile(sandbox))?.retry?.maxRetries).toBe(5);
		expect(text).toContain("retry.maxRetries");
		const [title, message] = confirm.mock.calls[0];
		expect(title).toContain("retry.maxRetries");
		expect(message).toContain("scope: global");
		expect(message).toContain("settings.json");
		expect(message).toContain("(unset) -> 5");
		expect(message).not.toContain("WARNING");
		expect(noted).toHaveBeenCalledWith(
			expect.any(Array),
			"the user approved",
			expect.objectContaining({ allowed: true }),
		);
	});

	it("leaves the settings unchanged when the user declines, and audits the refusal", async () => {
		const { run, noted } = setup();
		const { text } = await run({ op: "set", id: "retry.maxRetries", value: 5 }, { confirms: [false] });
		expect(readJson(globalSettingsFile(sandbox))?.retry).toBeUndefined();
		expect(text).toContain("declined");
		expect(noted).toHaveBeenCalledWith(
			expect.any(Array),
			"the user declined",
			expect.objectContaining({ allowed: false }),
		);
	});

	it.each(["manual", "workspace", "full", "bypass"] as const)("asks in %s mode", async (mode) => {
		const { run } = setup(mode);
		const { confirm } = await run({ op: "set", id: "retry.maxRetries", value: 4 }, { confirms: [false] });
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(readJson(globalSettingsFile(sandbox))?.retry).toBeUndefined();
	});

	it("refuses without a dialog and writes nothing", async () => {
		const { run, noted } = setup("bypass");
		await expect(
			run({ op: "set", id: "retry.maxRetries", value: 4 }, { hasUI: false, confirms: [true] }),
		).rejects.toThrow(/no dialog/);
		expect(readJson(globalSettingsFile(sandbox))?.retry).toBeUndefined();
		expect(noted).toHaveBeenCalledWith(
			expect.any(Array),
			expect.stringContaining("no dialog"),
			expect.objectContaining({ allowed: false }),
		);
	});

	it("reads without asking", async () => {
		const { run } = setup("full");
		const listed = await run({ op: "list", id: "retry.maxRetries" });
		expect(listed.text).toContain("retry.maxRetries");
		const got = await run({ op: "get", id: "retry.maxRetries" });
		expect(got.text).toContain("retry.maxRetries");
		expect(listed.confirm).not.toHaveBeenCalled();
		expect(got.confirm).not.toHaveBeenCalled();
	});

	it("shows a security warning for a sensitive key and none for an ordinary one", async () => {
		const { run } = setup();
		const { confirm } = await run({ op: "set", id: "sandbox.mode", value: "off" }, { confirms: [false] });
		expect(confirm.mock.calls[0][0]).toContain("Security-relevant");
		expect(confirm.mock.calls[0][1]).toMatch(/^WARNING/);
	});

	it("redacts secret-looking values in the approval", async () => {
		const { run } = setup();
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
		const { confirm } = await run(
			{ op: "set", id: "httpProxy", value: `http://user:${secret}@proxy.test` },
			{ confirms: [false] },
		);
		expect(confirm.mock.calls[0][1]).not.toContain(secret);
	});

	it("refuses workspace scope when the folder is untrusted, after the user approves", async () => {
		const { run } = setup("workspace", { trusted: false });
		const { text } = await run(
			{ op: "set", id: "retry.maxRetries", value: 2, scope: "workspace" },
			{ confirms: [true] },
		);
		expect(text).toMatch(/Refused/);
		expect(fs.existsSync(projectSettingsFile(sandbox))).toBe(false);
	});

	it("writes the workspace file when the folder is trusted", async () => {
		const { run } = setup();
		await run({ op: "set", id: "retry.maxRetries", value: 2, scope: "workspace" }, { confirms: [true] });
		expect(readJson(projectSettingsFile(sandbox))?.retry?.maxRetries).toBe(2);
		expect(projectSettingsFile(sandbox)).toContain(CONFIG_DIR_NAME);
	});

	it("is not registered for a subagent", () => {
		expect(setup("workspace", { isSubagent: true }).tools.has("configuration")).toBe(false);
		expect(setup("workspace").tools.has("configuration")).toBe(true);
	});
});

describe("sensitive configuration list", () => {
	it.each([
		"sandbox.mode",
		"security.enforce",
		"remote.autoStart",
		"bash.inheritProviderKeys",
		"research.allowedPaths",
		"retention.days",
		"mcp:docs",
		"hook:gate",
	])("flags %s", (id) => expect(sensitiveReason(id)).toBeTruthy());

	it.each(["retry.maxRetries", "theme", "tool:web", "bash.spillMaxBytes"])("leaves %s ordinary", (id) =>
		expect(sensitiveReason(id)).toBeUndefined(),
	);
});
