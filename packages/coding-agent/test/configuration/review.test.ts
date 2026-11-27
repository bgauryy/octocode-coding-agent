import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/octocode/mcp-host/core-install.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMcpReload } from "../../../mcp/src/switch.ts";
import { CONFIG_DIR_NAME, getOctocodeSkillsDir } from "../../src/config.ts";
import { coerceSettingValue, findLeaf } from "../../src/configuration/settings-leaves.ts";
import { parseConfigWords, runConfigWords, splitConfigWords } from "../../src/configuration/command.ts";
import { applyRunFlags } from "../../src/configuration/run-flags.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { configuration, context, globalSettingsFile, readJson } from "./helpers.ts";
import { createConfiguration } from "../../src/configuration/index.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => {
	vi.restoreAllMocks();
	sandbox.cleanup();
});

const run = (line: string, live?: Parameters<typeof configuration>[1]) =>
	runConfigWords(configuration(sandbox, live), splitConfigWords(line), "/settings");

/** A project hook file with one hook that denies when it fails. */
function writeGateHook(): void {
	const dir = join(sandbox.cwd, CONFIG_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "hooks.json"),
		JSON.stringify({
			hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true", failClosed: true }] }] },
		}),
	);
}

describe("several ids in one command", () => {
	it("keeps every write: two tools disabled together both persist", async () => {
		const outcome = await run("disable tool:backlog tool:timer");
		expect(outcome.ok).toBe(true);
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-backlog", "-timer"]);
	});
});

describe("words", () => {
	it("keeps --json and --trust after -- for the server's own arguments", async () => {
		const outcome = await run("add mcp foo -- mycmd --json --trust");
		expect(outcome.ok).toBe(true);
		const server = readJson(join(sandbox.home, ".octocode", "mcp.json"))?.mcpServers?.foo;
		expect(server).toMatchObject({ command: "mycmd", args: ["--json", "--trust"] });
	});

	it("groups quotes inside a word", () => {
		expect(splitConfigWords("add mcp x --env KEY=\"a b\" 'c d' plain")).toEqual([
			"add",
			"mcp",
			"x",
			"--env",
			"KEY=a b",
			"c d",
			"plain",
		]);
		expect(parseConfigWords(["disable", "hook:x", "--force"])).toMatchObject({
			force: true,
			words: ["disable", "hook:x"],
		});
	});
});

describe("gate hooks and locked rows", () => {
	it("refuses a gate hook without --force, names the flag, and switches it off with --force", async () => {
		writeGateHook();
		const catalog = configuration(sandbox);
		const gate = (await catalog.list({ kinds: ["hook"] })).find((entry) =>
			/gate/.test(`${entry.detail ?? ""}${entry.label}`),
		);
		expect(gate, "a gate hook is listed").toBeDefined();
		const refused = await runConfigWords(catalog, ["disable", gate!.id], "/settings");
		expect(refused.ok).toBe(false);
		expect(refused.lines.join("\n")).toContain("--force");
		const forced = await runConfigWords(catalog, ["disable", gate!.id, "--force"], "/settings");
		expect(forced.ok).toBe(true);
		expect(readJson(globalSettingsFile(sandbox))?.toggles?.[gate!.id]).toBe(false);
	});

	it("does not let a run flag switch a gate hook off", async () => {
		writeGateHook();
		const ctx = context(sandbox);
		const gate = (await configuration(sandbox).list({ kinds: ["hook"] })).find((entry) =>
			/gate/.test(`${entry.detail ?? ""}${entry.label}`),
		);
		const refused = await applyRunFlags(parseArgs(["--disable", gate!.id]), ctx);
		expect(refused).toHaveLength(1);
		expect(ctx.settings.getToggles()[gate!.id]).toBeUndefined();
	});
});

describe("harness switches reload MCP once per command", () => {
	it("requests one reload after all harness ops and says the servers applied now", async () => {
		const mcpReload = vi.fn(async () => ({ added: ["docs"], removed: [] }));
		const outcome = await run("enable harness:claude harness:codex", { live: { mcpReload } });
		expect(outcome.ok).toBe(true);
		expect(mcpReload).toHaveBeenCalledOnce();
		expect(outcome.lines.join("\n")).toContain("MCP servers applied now: docs");
		mcpReload.mockClear();
		await run("enable tool:backlog", { live: { mcpReload } });
		expect(mcpReload).not.toHaveBeenCalled();
	});

	it("keeps the saved switch and says the reload failed when the session's MCP reload rejects", async () => {
		const events = createEventBus();
		events.on("mcp:reload:request", (reply) =>
			(reply as (handle: () => Promise<never>) => void)(() => Promise.reject(new Error("session aborted"))),
		);
		const outcome = await run("enable harness:claude", { live: { mcpReload: () => requestMcpReload(events) } });
		expect(outcome.lines.join("\n")).toContain("switches are saved, but the MCP reload failed (session aborted)");
		expect(readJson(globalSettingsFile(sandbox))?.toggles).toEqual({ "harness:claude": true });
	});
});

describe("live settings", () => {
	it("applies an unset live key at once, with the value that now applies, and never writes it back", async () => {
		await run("set theme light");
		const applied: string[][] = [];
		const applySetting = vi.fn((key: string) => {
			applied.push([key]);
			return key === "theme";
		});
		const outcome = await run("unset theme", { live: { applySetting, appliesLive: (key) => key === "theme" } });
		expect(outcome.ok).toBe(true);
		expect(outcome.lines.join("\n")).toContain("applies now");
		// The applier applies what the files now hold (the default again) and saves nothing: the key stays removed.
		expect(applied).toEqual([["theme"]]);
		expect(readJson(globalSettingsFile(sandbox))?.theme).toBeUndefined();
	});

	it("writes through the session's own settings manager, so a live key applies the new value whatever it stores in", async () => {
		// A host may run on an in-memory manager (an SDK embedder, the e2e harness): the write must reach what it reads.
		const settings = SettingsManager.inMemory({ outputPad: 1 });
		const seen: unknown[] = [];
		const catalog = createConfiguration({
			...context(sandbox),
			settings,
			live: { applySetting: (key) => (seen.push(settings.getOutputPad()), key === "outputPad") },
		});
		const outcome = await runConfigWords(catalog, splitConfigWords("set outputPad 0"), "/settings");
		expect(outcome.lines.join("\n")).toContain("applies now");
		expect(seen).toEqual([0]);
		expect(settings.getOutputPad()).toBe(0);
		await runConfigWords(catalog, splitConfigWords("unset outputPad"), "/settings");
		expect(settings.getGlobalSettings().outputPad).toBeUndefined();
	});

	it("says a live key applies now in get and list, not after /reload", async () => {
		const live = { applySetting: () => true, appliesLive: (key: string) => key === "theme" };
		const got = (await run("get theme", { live })).lines.join("\n");
		expect(got).toContain("applies now");
		expect(got).not.toContain("after /reload");
		const other = (await run("get retry.maxRetries", { live })).lines.join("\n");
		expect(other).toContain("applies after /reload");
	});

	it("applies a live key through the host applier and reports now", async () => {
		const applySetting = vi.fn((key: string) => key === "theme");
		const outcome = await run("set theme dark", { live: { applySetting } });
		// Contract change (wave D): the hook takes no value; it applies what the files now hold, so an unset applies too.
		expect(applySetting).toHaveBeenCalledWith("theme");
		expect(outcome.lines.join("\n")).toContain("applies now");
		const other = await run("set retry.maxRetries 4", { live: { applySetting } });
		expect(other.lines.join("\n")).toContain("Interface and session");
	});
});

describe("value messages", () => {
	it("names the accepted values of a union key", () => {
		const leaf = findLeaf("terminal.reduceMotion");
		expect(leaf).toBeDefined();
		const coerced = coerceSettingValue(leaf!, "maybe");
		expect(coerced.ok).toBe(false);
		if (!coerced.ok) expect(coerced.reason).toMatch(/true\|false/);
	});
});

describe("core skills", () => {
	it("switches a core skill through the global skills pattern and refuses the project scope", async () => {
		// A core skill the Octocode collection has no copy of: a same-named collection row would take the id.
		const listed = await configuration(sandbox).list({ kinds: ["skill"] });
		const core = listed.find((entry) => entry.id === "skill:resume-external-harness");
		expect(core, "the core skill is listed").toBeDefined();
		expect((await run("disable skill:resume-external-harness")).ok).toBe(true);
		expect(readJson(globalSettingsFile(sandbox))?.skills?.some((pattern: string) => pattern.startsWith("-"))).toBe(
			true,
		);
		const off = (await configuration(sandbox).list({ kinds: ["skill"] })).find((entry) => entry.id === core!.id);
		expect(off?.value).toBe(false);
		expect((await run("enable skill:resume-external-harness")).ok).toBe(true);
		const on = (await configuration(sandbox).list({ kinds: ["skill"] })).find((entry) => entry.id === core!.id);
		expect(on?.value).toBe(true);
		const project = await run("disable skill:resume-external-harness --local");
		expect(project.ok).toBe(false);
	});
});

const collection = getOctocodeSkillsDir();
const collectionHasDebugging =
	collection !== undefined && existsSync(join(collection, "octocode-debugging", "SKILL.md"));

describe("a core skill the Octocode collection also ships", () => {
	it.skipIf(!collectionHasDebugging)(
		"lists only the core copy, under the name: the collection's copy of a core skill is not offered",
		async () => {
			const listed = (await configuration(sandbox).list({ kinds: ["skill"] })).filter(
				(entry) => entry.label === "octocode-debugging",
			);
			// Both ship with Octocode and the core one always wins, so no row says the collection copy lost.
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ id: "skill:octocode-debugging", value: true });
			expect(listed[0]?.detail).toContain("native/skills");
			expect(listed[0]?.detail).not.toMatch(/^shadowed/);
			// `disable skill:<name>` switches the copy that loads: the core skill's global pattern, and the name is off.
			expect((await run("disable skill:octocode-debugging")).ok).toBe(true);
			expect(readJson(globalSettingsFile(sandbox))?.skills).toEqual(["-octocode-debugging/SKILL.md"]);
			const after = (await configuration(sandbox).list({ kinds: ["skill"] })).filter(
				(entry) => entry.label === "octocode-debugging",
			);
			expect(after).toHaveLength(1);
			expect(after[0]).toMatchObject({ id: "skill:octocode-debugging", value: false });
			expect(after[0]?.detail).toContain("native/skills");
		},
	);
});

describe("project overrides cycle", () => {
	const projectSettings = () => readJson(join(sandbox.cwd, CONFIG_DIR_NAME, "settings.json"));

	it("cycles a package resource in project scope: off, on, then back to inheriting", async () => {
		const pkg = join(sandbox.home, "pkg");
		mkdirSync(join(pkg, "skills", "cycler"), { recursive: true });
		writeFileSync(join(pkg, "skills", "cycler", "SKILL.md"), "---\nname: cycler\ndescription: Cycles.\n---\nBody\n");
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pkg", octocode: { skills: ["skills"] } }));
		mkdirSync(sandbox.agentDir, { recursive: true });
		writeFileSync(globalSettingsFile(sandbox), JSON.stringify({ packages: [pkg] }));
		const value = async () =>
			(await configuration(sandbox).list({ kinds: ["skill"] })).find((entry) => entry.id === "skill:cycler")?.value;
		expect(await value()).toBe(true);
		expect((await run("disable skill:cycler --local")).ok).toBe(true);
		expect(await value()).toBe(false);
		const off = JSON.stringify(projectSettings());
		expect((await run("enable skill:cycler --local")).ok).toBe(true);
		expect(await value()).toBe(true);
		expect(JSON.stringify(projectSettings())).not.toBe(off);
		expect((await run("unset skill:cycler --local")).ok).toBe(true);
		expect(await value()).toBe(true);
	});
});
