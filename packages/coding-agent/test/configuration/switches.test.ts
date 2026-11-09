import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, createSandbox, skillFile, write } from "../discovery/fixtures.ts";
import { configuration, globalSettingsFile, projectSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

describe("tool:<name>", () => {
	it("lists native tools as toggles", async () => {
		const entries = await configuration(sandbox).list({ kinds: ["tool"] });
		expect(entries.find((entry) => entry.id === "tool:backlog")).toMatchObject({
			valueType: { type: "toggle" },
			value: true,
			setBy: "default",
			appliesWhen: "next-session",
		});
	});

	it("writes -name and +name modifiers at global and project scope", async () => {
		const catalog = configuration(sandbox);
		expect((await catalog.apply({ verb: "disable", id: "tool:backlog" })).status).toBe("applied");
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-backlog"]);
		await catalog.apply({ verb: "disable", id: "tool:timer", scope: "project" });
		expect(readJson(projectSettingsFile(sandbox))?.defaultTools).toEqual(["-timer"]);
		await catalog.apply({ verb: "enable", id: "tool:backlog" });
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["+backlog"]);
		expect(await catalog.get("tool:timer")).toMatchObject({ value: false, setBy: "project" });
	});

	it("adds to and removes from a plain allowlist", async () => {
		write(globalSettingsFile(sandbox), JSON.stringify({ defaultTools: ["bash", "file"] }));
		const fresh = configuration(sandbox);
		await fresh.apply({ verb: "enable", id: "tool:web" });
		await fresh.apply({ verb: "disable", id: "tool:file" });
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["bash", "web"]);
	});

	it("refuses an unknown tool with suggestions, an untrusted project, and run scope leaves files alone", async () => {
		const catalog = configuration(sandbox);
		expect(await catalog.apply({ verb: "disable", id: "tool:backlg" })).toMatchObject({
			status: "refused",
			suggestions: expect.arrayContaining(["tool:backlog"]),
		});
		expect(await catalog.apply({ verb: "set", id: "tool:backlog", value: "1" })).toMatchObject({ status: "refused" });
		expect(
			await configuration(sandbox, { trusted: false }).apply({ verb: "disable", id: "tool:backlog", scope: "project" }),
		).toMatchObject({ status: "refused", reason: expect.stringContaining("not trusted") });
		expect((await catalog.apply({ verb: "disable", id: "tool:backlog", scope: "run" })).status).toBe("applied");
		expect(readJson(globalSettingsFile(sandbox))).toBeUndefined();
		expect(await catalog.get("tool:backlog")).toMatchObject({ value: false });
	});
});

describe("harness:<id>", () => {
	it("lists harnesses, writes the toggles key and drops it when the default gives the state", async () => {
		const catalog = configuration(sandbox);
		expect(await catalog.get("harness:claude")).toMatchObject({ value: false, appliesWhen: "reload" });
		expect((await catalog.apply({ verb: "enable", id: "harness:claude" })).status).toBe("applied");
		expect(readJson(globalSettingsFile(sandbox))?.toggles).toEqual({ "harness:claude": true });
		await catalog.apply({ verb: "enable", id: "harness:cursor", scope: "project" });
		expect(readJson(projectSettingsFile(sandbox))?.toggles).toEqual({ "harness:cursor": true });
		await catalog.apply({ verb: "disable", id: "harness:claude" });
		expect(readJson(globalSettingsFile(sandbox))?.toggles).toEqual({});
	});

	it("refuses untrusted project, unknown ids with suggestions, and run scope writes no file", async () => {
		const catalog = configuration(sandbox);
		expect(
			await configuration(sandbox, { trusted: false }).apply({
				verb: "enable",
				id: "harness:claude",
				scope: "project",
			}),
		).toMatchObject({ status: "refused" });
		expect(await catalog.apply({ verb: "enable", id: "harness:claud" })).toMatchObject({
			status: "refused",
			suggestions: expect.arrayContaining(["harness:claude"]),
		});
		expect((await catalog.apply({ verb: "enable", id: "harness:codex", scope: "run" })).status).toBe("applied");
		expect(readJson(globalSettingsFile(sandbox))).toBeUndefined();
	});
});

describe("skill:<name> and the other resources", () => {
	it("lists a skill, switches it through the settings patterns and refuses unknown names", async () => {
		skillFile(join(sandbox.agentDir, "skills"), "alpha");
		const catalog = configuration(sandbox);
		expect(await catalog.get("skill:alpha")).toMatchObject({
			kind: "skill",
			value: true,
			valueType: { type: "toggle" },
		});
		expect((await catalog.apply({ verb: "disable", id: "skill:alpha" })).status).toBe("applied");
		expect(JSON.stringify(readJson(globalSettingsFile(sandbox))?.skills)).toContain("alpha");
		expect(await configuration(sandbox).get("skill:alpha")).toMatchObject({ value: false });
		expect(await catalog.apply({ verb: "disable", id: "skill:alpah" })).toMatchObject({
			status: "refused",
			suggestions: expect.arrayContaining(["skill:alpha"]),
		});
		expect((await catalog.apply({ verb: "disable", id: "skill:alpha", scope: "run" })).status).toBe("refused");
	});

	it("writes a project override and refuses it in an untrusted folder", async () => {
		skillFile(join(sandbox.agentDir, "skills"), "beta");
		const result = await configuration(sandbox).apply({ verb: "disable", id: "skill:beta", scope: "project" });
		expect(result.status).toBe("applied");
		expect(JSON.stringify(readJson(projectSettingsFile(sandbox))?.skills)).toContain("beta");
		expect(
			(await configuration(sandbox, { trusted: false }).apply({ verb: "disable", id: "skill:beta", scope: "project" }))
				.status,
		).toBe("refused");
	});
});

describe("provider:<id> and source:<id>", () => {
	it("round-trips disabledProviders globally and refuses project scope", async () => {
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "disable", id: "provider:anthropic" });
		expect(readJson(globalSettingsFile(sandbox))?.disabledProviders).toEqual(["anthropic"]);
		expect(await catalog.get("provider:anthropic")).toMatchObject({ value: false, setBy: "global" });
		await catalog.apply({ verb: "enable", id: "provider:anthropic" });
		expect(readJson(globalSettingsFile(sandbox))?.disabledProviders).toEqual([]);
		expect(await catalog.apply({ verb: "disable", id: "provider:anthropic", scope: "project" })).toMatchObject({
			status: "refused",
		});
		expect(await catalog.apply({ verb: "disable", id: "provider:anthropik" })).toMatchObject({
			status: "refused",
			suggestions: expect.arrayContaining(["provider:anthropic"]),
		});
	});

	it("switches a source, dropping the key when it equals the default, and refuses the always-on one", async () => {
		const catalog = configuration(sandbox);
		await catalog.apply({ verb: "disable", id: "source:pi" });
		expect(readJson(globalSettingsFile(sandbox))?.providerSources).toEqual({ pi: false });
		await catalog.apply({ verb: "enable", id: "source:pi" });
		expect(readJson(globalSettingsFile(sandbox))?.providerSources).toEqual({});
		expect(await catalog.apply({ verb: "disable", id: "source:octocode" })).toMatchObject({
			status: "refused",
			reason: expect.stringContaining("always on"),
		});
		expect((await catalog.apply({ verb: "disable", id: "source:pi", scope: "run" })).status).toBe("refused");
	});
});
