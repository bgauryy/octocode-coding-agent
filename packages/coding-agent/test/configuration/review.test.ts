import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/octocode/mcp-host/core-install.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMcpReload } from "../../../mcp/src/switch.ts";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { coerceSettingValue, findLeaf } from "../../src/configuration/settings-leaves.ts";
import { parseConfigWords, runConfigWords, splitConfigWords } from "../../src/configuration/command.ts";
import { applyRunFlags } from "../../src/configuration/run-flags.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { configuration, context, globalSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => {
	vi.restoreAllMocks();
	sandbox.cleanup();
});

const run = (line: string, live?: Parameters<typeof configuration>[1]) =>
	runConfigWords(configuration(sandbox, live), splitConfigWords(line), "/configuration");

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
		const refused = await runConfigWords(catalog, ["disable", gate!.id], "/configuration");
		expect(refused.ok).toBe(false);
		expect(refused.lines.join("\n")).toContain("--force");
		const forced = await runConfigWords(catalog, ["disable", gate!.id, "--force"], "/configuration");
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
	it("applies a live key through the host applier and reports now", async () => {
		const applySetting = vi.fn((key: string) => key === "theme");
		const outcome = await run("set theme dark", { live: { applySetting } });
		expect(applySetting).toHaveBeenCalledWith("theme", "dark");
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
		const listed = await configuration(sandbox).list({ kinds: ["skill"] });
		const core = listed.find((entry) => entry.id === "skill:octocode-debugging");
		expect(core, "the core skill is listed").toBeDefined();
		expect((await run("disable skill:octocode-debugging")).ok).toBe(true);
		expect(readJson(globalSettingsFile(sandbox))?.skills?.some((pattern: string) => pattern.startsWith("-"))).toBe(
			true,
		);
		const off = (await configuration(sandbox).list({ kinds: ["skill"] })).find((entry) => entry.id === core!.id);
		expect(off?.value).toBe(false);
		expect((await run("enable skill:octocode-debugging")).ok).toBe(true);
		const on = (await configuration(sandbox).list({ kinds: ["skill"] })).find((entry) => entry.id === core!.id);
		expect(on?.value).toBe(true);
		const project = await run("disable skill:octocode-debugging --local");
		expect(project.ok).toBe(false);
	});
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

	it("cycles the built-in llama.cpp extension: project off, on, inherit", async () => {
		const value = async () =>
			(await configuration(sandbox).list({ kinds: ["extension"] })).find((entry) => entry.id === "extension:llama.cpp")
				?.value;
		expect(await value()).toBe(true);
		expect((await run("disable extension:llama.cpp --local")).ok).toBe(true);
		expect(await value()).toBe(false);
		expect((await run("enable extension:llama.cpp --local")).ok).toBe(true);
		expect(await value()).toBe(true);
		expect((await run("unset extension:llama.cpp --local")).ok).toBe(true);
		expect(await value()).toBe(true);
	});
});
