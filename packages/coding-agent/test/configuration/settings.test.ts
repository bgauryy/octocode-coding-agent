import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConfigWords } from "../../src/configuration/command.ts";
import { settingLeaves } from "../../src/configuration/settings-leaves.ts";
import { GLOBAL_ONLY_SETTINGS, globalOnlyRoot } from "../../src/core/settings-manager/global-only.ts";
import { type Sandbox, createSandbox, write } from "../discovery/fixtures.ts";
import { configuration, globalSettingsFile, projectSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

describe("settings entries", () => {
	it("lists schema leaves with type, description and default, and not the keys other kinds own", async () => {
		const entries = await configuration(sandbox).list({ kinds: ["setting"] });
		const entry = entries.find((candidate) => candidate.id === "retry.maxRetries");
		expect(entry).toMatchObject({
			kind: "setting",
			valueType: { type: "number" },
			default: 3,
			setBy: "default",
			value: 3,
		});
		expect(entries.find((candidate) => candidate.id === "transport")?.valueType).toEqual({
			type: "enum",
			values: ["auto", "sse"],
		});
		expect(entries.some((candidate) => ["toggles", "defaultTools", "skills"].includes(candidate.id))).toBe(false);
	});

	it("sets a nested key globally and reports the scope that set it", async () => {
		const catalog = configuration(sandbox);
		const result = await catalog.apply({ verb: "set", id: "retry.maxRetries", value: "5" });
		expect(result).toMatchObject({ status: "applied", scope: "global", appliesWhen: "reload" });
		expect(readJson(globalSettingsFile(sandbox))?.retry).toEqual({ maxRetries: 5 });
		expect(readJson(projectSettingsFile(sandbox))).toBeUndefined();
		expect(await catalog.get("retry.maxRetries")).toMatchObject({ value: 5, setBy: "global", scopes: { global: 5 } });
	});

	it("sets a project key in the project file and wins over global", async () => {
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "set", id: "bash.spillMaxBytes", value: "100" });
		const result = await catalog.apply({ verb: "set", id: "bash.spillMaxBytes", value: "200", scope: "project" });
		expect(result.status).toBe("applied");
		expect(readJson(projectSettingsFile(sandbox))?.bash).toEqual({ spillMaxBytes: 200 });
		expect(readJson(globalSettingsFile(sandbox))?.bash).toEqual({ spillMaxBytes: 100 });
		expect(await catalog.get("bash.spillMaxBytes")).toMatchObject({
			value: 200,
			setBy: "project",
			scopes: { global: 100, project: 200 },
		});
	});

	it("round-trips booleans through enable and disable, and enums through the typed setter", async () => {
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "disable", id: "enableSkillCommands" });
		await catalog.apply({ verb: "set", id: "transport", value: "sse" });
		expect(readJson(globalSettingsFile(sandbox))).toMatchObject({ enableSkillCommands: false, transport: "sse" });
		await catalog.apply({ verb: "enable", id: "enableSkillCommands" });
		expect(readJson(globalSettingsFile(sandbox))?.enableSkillCommands).toBe(true);
	});

	it("unsets a key and drops the section it empties", async () => {
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "set", id: "retry.maxRetries", value: "5" });
		const result = await catalog.apply({ verb: "unset", id: "retry.maxRetries" });
		expect(result.status).toBe("applied");
		expect(readJson(globalSettingsFile(sandbox))).toEqual({});
	});

	it("keeps unrelated keys when it writes", async () => {
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "set", id: "theme", value: "dark" });
		await catalog.apply({ verb: "set", id: "retry.baseDelayMs", value: "10" });
		expect(readJson(globalSettingsFile(sandbox))).toMatchObject({ theme: "dark", retry: { baseDelayMs: 10 } });
	});

	it("refuses an invalid value with the reason and writes nothing", async () => {
		const catalog = configuration(sandbox);
		const number = await catalog.apply({ verb: "set", id: "retry.maxRetries", value: "many" });
		const enumeration = await catalog.apply({ verb: "set", id: "transport", value: "carrier-pigeon" });
		const notBoolean = await catalog.apply({ verb: "enable", id: "transport" });
		expect(number).toMatchObject({ status: "refused", reason: expect.stringContaining("expected a number") });
		expect(enumeration).toMatchObject({ status: "refused", reason: expect.stringContaining("one of auto, sse") });
		expect(notBoolean.status).toBe("refused");
		expect(readJson(globalSettingsFile(sandbox))).toBeUndefined();
	});

	it("refuses an unknown key with the closest keys", async () => {
		const result = await configuration(sandbox).apply({ verb: "set", id: "retry.maxRetrys", value: "1" });
		expect(result).toMatchObject({ status: "refused", suggestions: expect.arrayContaining(["retry.maxRetries"]) });
	});

	it("refuses a key another kind owns and names the owner", async () => {
		const result = await configuration(sandbox).apply({ verb: "set", id: "toggles", value: "{}" });
		expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("harness:<id>") });
	});

	it("refuses project scope in an untrusted folder, with the reason, and writes nothing", async () => {
		const result = await configuration(sandbox, { trusted: false }).apply({
			verb: "set",
			id: "retry.maxRetries",
			value: "5",
			scope: "project",
		});
		expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("not trusted") });
		expect(readJson(projectSettingsFile(sandbox))).toBeUndefined();
	});

	it("run scope changes the manager in memory and leaves the files alone", async () => {
		const catalog = configuration(sandbox);
		const result = await catalog.apply({ verb: "set", id: "retry.maxRetries", value: "9", scope: "run" });
		expect(result).toMatchObject({ status: "applied", scope: "run", appliesWhen: "now" });
		expect(readJson(globalSettingsFile(sandbox))).toBeUndefined();
		expect(readJson(projectSettingsFile(sandbox))).toBeUndefined();
		expect(await catalog.get("retry.maxRetries")).toMatchObject({ value: 9 });
		expect((await catalog.apply({ verb: "unset", id: "retry.maxRetries", scope: "run" })).status).toBe("refused");
	});

	it("reports a global-only key's global value and notes that the project value is ignored", async () => {
		write(globalSettingsFile(sandbox), JSON.stringify({ sandbox: { mode: "on" } }));
		write(
			projectSettingsFile(sandbox),
			JSON.stringify({ sandbox: { mode: "off" }, bash: { inheritProviderKeys: true } }),
		);
		const catalog = configuration(sandbox);
		expect(await catalog.get("sandbox.mode")).toMatchObject({
			value: "on",
			setBy: "global",
			scopes: { global: "on", project: "off" },
			detail: expect.stringMatching(/global settings only.*project value "off" is ignored/),
		});
		expect(await catalog.get("bash.inheritProviderKeys")).toMatchObject({ value: false, setBy: "default" });
		expect((await catalog.get("sandbox.allowUnsandboxed"))?.detail).toMatch(/global settings only/);
		const text = (await runConfigWords(catalog, ["get", "sandbox.mode"], "/settings")).lines.join("\n");
		expect(text).toContain("value: on (set by global");
		expect(text).toContain('the project value "off" is ignored');
	});

	it("refuses --local and a per-run value for a global-only key with the reason, and still unsets a project value", async () => {
		write(projectSettingsFile(sandbox), JSON.stringify({ sandbox: { mode: "off" } }));
		const catalog = configuration(sandbox);
		for (const op of [
			{ verb: "set", id: "sandbox.mode", value: "off", scope: "project" },
			{ verb: "enable", id: "bash.inheritProviderKeys", scope: "project" },
			{ verb: "set", id: "sandbox.mode", value: "on", scope: "run" },
			{ verb: "set", id: "retention.days", value: "1", scope: "project" },
		] as const)
			expect(await catalog.apply(op)).toMatchObject({
				status: "refused",
				reason: expect.stringContaining("read from the global settings only"),
			});
		expect(readJson(projectSettingsFile(sandbox))).toEqual({ sandbox: { mode: "off" } });
		const local = await runConfigWords(catalog, ["set", "sandbox.mode", "off", "--local"], "/settings");
		expect(local).toMatchObject({ ok: false });
		expect(local.lines[0]).toMatch(/^Refused set sandbox\.mode: .*project value would do nothing/);
		expect(await catalog.apply({ verb: "unset", id: "sandbox.mode", scope: "project" })).toMatchObject({
			status: "applied",
		});
		expect(readJson(projectSettingsFile(sandbox))).toEqual({});
		expect((await catalog.apply({ verb: "set", id: "sandbox.mode", value: "auto" })).status).toBe("applied");
		expect(readJson(globalSettingsFile(sandbox))?.sandbox).toEqual({ mode: "auto" });
	});

	it("names only settings keys as global-only", () => {
		const keys = settingLeaves().map((leaf) => leaf.key);
		for (const root of GLOBAL_ONLY_SETTINGS)
			expect(
				keys.some((key) => key === root || key.startsWith(`${root}.`)),
				root,
			).toBe(true);
		expect(globalOnlyRoot("sandbox.mode")).toBe("sandbox");
		expect(globalOnlyRoot("bash.spillMaxBytes")).toBeUndefined();
	});

	it("refuses add and remove at run scope for every kind", async () => {
		const result = await configuration(sandbox).apply({ verb: "remove", id: "mcp:x", scope: "run" });
		expect(result.status).toBe("refused");
	});

	it("an unknown kind is refused with the closest known ids", async () => {
		const result = await configuration(sandbox).apply({ verb: "enable", id: "tol:bash" });
		expect(result).toMatchObject({ status: "refused", suggestions: expect.arrayContaining(["tool:bash"]) });
	});
});
