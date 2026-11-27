import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguration } from "../../src/configuration/index.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createSandbox, type Sandbox, write } from "../discovery/fixtures.ts";
import { context, globalSettingsFile, projectSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const defaults = [
	{ id: "defaultProvider", value: "local" },
	{ id: "defaultModel", value: "qwen-local" },
] as const;
const scopes = ["global", "project"] as const;

describe("configuration model defaults", () => {
	it.each(defaults)("keeps run-scoped $id for new sessions without saving a file", async ({ id, value }) => {
		const ctx = context(sandbox);
		const result = await createConfiguration(ctx).apply({ verb: "set", id, value, scope: "run" });

		expect(result).toMatchObject({
			status: "applied",
			scope: "run",
			appliesWhen: "next-session",
			message: expect.stringContaining("the current chat keeps its model"),
		});
		expect(ctx.settings.getSettings()[id]).toBe(value);
		expect(readJson(globalSettingsFile(sandbox))).toBeUndefined();
		expect(readJson(projectSettingsFile(sandbox))).toBeUndefined();
	});

	it("keeps generic run-scoped settings effective immediately", async () => {
		const ctx = context(sandbox);
		const result = await createConfiguration(ctx).apply({
			verb: "set",
			id: "retry.maxRetries",
			value: 9,
			scope: "run",
		});

		expect(result).toMatchObject({ status: "applied", scope: "run", appliesWhen: "now" });
		expect(ctx.settings.getSettings().retry?.maxRetries).toBe(9);
		expect(readJson(globalSettingsFile(sandbox))).toBeUndefined();
		expect(readJson(projectSettingsFile(sandbox))).toBeUndefined();
	});

	it.each(scopes)("saves %s defaults, reloads the active manager and survives a new manager", async (scope) => {
		const file = scope === "global" ? globalSettingsFile(sandbox) : projectSettingsFile(sandbox);
		write(file, JSON.stringify({ theme: "dark" }));
		const ctx = context(sandbox);
		const catalog = createConfiguration(ctx);

		for (const { id, value } of defaults) {
			await expect(catalog.apply({ verb: "set", id, value, scope })).resolves.toMatchObject({
				status: "applied",
				scope,
				appliesWhen: "next-session",
				message: expect.stringContaining("the current chat keeps its model"),
			});
			expect(await catalog.get(id)).toMatchObject({ value, appliesWhen: "next-session" });
		}

		expect(readJson(file)).toEqual({ theme: "dark", defaultProvider: "local", defaultModel: "qwen-local" });
		expect(ctx.settings.getDefaultProvider()).toBe("local");
		expect(ctx.settings.getDefaultModel()).toBe("qwen-local");
		const reopened = SettingsManager.create(sandbox.cwd, sandbox.agentDir, { projectTrusted: true });
		expect(reopened.getDefaultProvider()).toBe("local");
		expect(reopened.getDefaultModel()).toBe("qwen-local");
	});

	it.each(scopes)("clears %s defaults for new sessions without removing other settings", async (scope) => {
		const file = scope === "global" ? globalSettingsFile(sandbox) : projectSettingsFile(sandbox);
		write(file, JSON.stringify({ theme: "dark", defaultProvider: "local", defaultModel: "qwen-local" }));
		const ctx = context(sandbox);
		const catalog = createConfiguration(ctx);

		for (const { id } of defaults) {
			await expect(catalog.apply({ verb: "unset", id, scope })).resolves.toMatchObject({
				status: "applied",
				appliesWhen: "next-session",
			});
		}
		expect(readJson(file)).toEqual({ theme: "dark" });
		expect(ctx.settings.getDefaultProvider()).toBeUndefined();
		expect(ctx.settings.getDefaultModel()).toBeUndefined();
	});

	it.each(scopes)("does not report saving %s defaults when the settings file becomes malformed", async (scope) => {
		const ctx = context(sandbox);
		const catalog = createConfiguration(ctx);
		const file = scope === "global" ? globalSettingsFile(sandbox) : projectSettingsFile(sandbox);
		const invalid = "{invalid-json";
		write(file, invalid);

		for (const { id, value } of defaults) {
			await expect(catalog.apply({ verb: "set", id, value, scope })).rejects.toThrow();
			expect(readFileSync(file, "utf8")).toBe(invalid);
		}
		expect(ctx.settings.getDefaultProvider()).toBeUndefined();
		expect(ctx.settings.getDefaultModel()).toBeUndefined();
	});

	it.each([...defaults, { id: "transport", value: "sse" }, { id: "defaultThinkingLevel", value: "high" }])(
		"does not report saving $id when its settings destination is a directory",
		async ({ id, value }) => {
			const ctx = context(sandbox);
			const catalog = createConfiguration(ctx);
			const file = globalSettingsFile(sandbox);
			mkdirSync(dirname(file), { recursive: true });
			mkdirSync(file);

			await expect(catalog.apply({ verb: "set", id, value })).rejects.toThrow();
			expect(ctx.settings.getDefaultProvider()).toBeUndefined();
			expect(ctx.settings.getDefaultModel()).toBeUndefined();
		},
	);
});
