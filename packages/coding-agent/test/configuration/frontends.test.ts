import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/octocode/mcp-host/core-install.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { runConfigWords, splitConfigWords } from "../../src/configuration/command.ts";
import { applyRunFlags } from "../../src/configuration/run-flags.ts";
import { handleConfigCommand } from "../../src/package-manager-cli/config-command.ts";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { configuration, context, globalSettingsFile, projectSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => {
	vi.restoreAllMocks();
	sandbox.cleanup();
});

const run = (line: string, options?: { trusted?: boolean }) =>
	runConfigWords(configuration(sandbox, options), splitConfigWords(line), "/configuration");

describe("/configuration text verbs", () => {
	it("lists by kind and text, gets one entry and reads values per scope", async () => {
		const listed = await run("list tool");
		expect(listed.ok).toBe(true);
		expect(listed.lines.join("\n")).toMatch(/tool:backlog\s+on\s+default\s+next-session/);
		expect((await run("list backlog")).lines.join("\n")).toContain("tool:backlog");
		expect((await run("get tool:backlog")).lines.join("\n")).toContain("value: on (set by default");
		expect(await run("get tool:nope")).toMatchObject({ ok: false });
	});

	it("pages a long list for the terminal and keeps the full list for a script", async () => {
		const paged = await runConfigWords(configuration(sandbox), ["list"], "/configuration", { listRows: 5 });
		const text = paged.lines.join("\n");
		expect(text).toMatch(/… \d+ more entries\. Filter: \/configuration list <kind>\|<text>/);
		expect(paged.lines.filter((line) => /^ {2}\S/.test(line))).toHaveLength(5);
		const filtered = await runConfigWords(configuration(sandbox), ["list", "tool"], "/configuration", { listRows: 2 });
		expect(filtered.lines.join("\n")).toContain("Narrow it: /configuration list <kind> <text>");
		expect((paged.json as unknown[]).length).toBeGreaterThan(5);
		expect((await run("list")).lines.join("\n")).not.toContain("more entries");
	});

	it("enables, disables, sets and unsets, and says when each applies", async () => {
		const off = await run("disable tool:backlog");
		expect(off).toMatchObject({ ok: true });
		expect(off.lines[0]).toContain("applies in the next session");
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-backlog"]);
		const set = await run("set retry.maxRetries 7");
		expect(set.lines[0]).toContain("applies after /reload");
		expect(readJson(globalSettingsFile(sandbox))?.retry?.maxRetries).toBe(7);
		expect((await run("set retry.maxRetries=8")).ok).toBe(true);
		expect((await run("unset retry.maxRetries")).ok).toBe(true);
		expect(readJson(globalSettingsFile(sandbox))?.retry?.maxRetries).toBeUndefined();
	});

	it("prints a refusal with suggestions, and the untrusted reason for --local", async () => {
		const unknown = await run("disable tool:backlg");
		expect(unknown.ok).toBe(false);
		expect(unknown.lines.join("\n")).toContain("Did you mean: tool:backlog");
		const local = await run("disable tool:backlog --local", { trusted: false });
		expect(local).toMatchObject({ ok: false });
		expect(local.lines[0]).toContain("not trusted");
		expect((await run("frobnicate")).lines[0]).toContain('Unknown verb "frobnicate"');
	});

	it("adds and removes an MCP server with the arguments of `octocode mcp add`", async () => {
		expect((await run("add mcp docs -- docs-server --flag")).ok).toBe(true);
		const file = join(sandbox.home, ".octocode", "mcp.json");
		expect(readJson(file)?.mcpServers.docs).toEqual({ command: "docs-server", args: ["--flag"] });
		expect((await run("add mcp web --url https://example.com/mcp --header A=b")).ok).toBe(true);
		expect(readJson(file)?.mcpServers.web).toMatchObject({ url: "https://example.com/mcp", headers: { A: "b" } });
		expect((await run("add mcp broken")).ok).toBe(false);
		expect((await run("add tool x")).ok).toBe(false);
		expect((await run("remove mcp:docs")).ok).toBe(true);
		expect(readJson(file)?.mcpServers.docs).toBeUndefined();
	});
});

describe("octocode configuration", () => {
	function capture() {
		const out: string[] = [];
		const err: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line) => void out.push(String(line)));
		vi.spyOn(console, "error").mockImplementation((line) => void err.push(String(line)));
		vi.spyOn(process, "cwd").mockReturnValue(sandbox.cwd);
		process.exitCode = undefined;
		return { out, err };
	}
	afterEach(() => {
		process.exitCode = undefined;
	});

	it("prints entries as JSON and exits zero", async () => {
		const { out } = capture();
		expect(await handleConfigCommand(["configuration", "list", "tool", "--json"])).toBe(true);
		const entries = JSON.parse(out.join("\n"));
		expect(entries.find((entry: { id: string }) => entry.id === "tool:backlog")).toMatchObject({
			kind: "tool",
			value: true,
		});
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("lists without a verb when there is no terminal, and writes through the same verbs", async () => {
		const { out } = capture();
		await handleConfigCommand(["configuration"]);
		expect(out.join("\n")).toContain("tool:backlog");
		await handleConfigCommand(["configuration", "disable", "tool:backlog", "--json"]);
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-backlog"]);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("exits non-zero with the reason for a refused change, as text and as JSON", async () => {
		const { err, out } = capture();
		await handleConfigCommand(["configuration", "enable", "tool:nope"]);
		expect(process.exitCode).toBe(1);
		expect(err.join("\n")).toContain("Unknown tool");
		process.exitCode = undefined;
		out.length = 0;
		await handleConfigCommand(["configuration", "enable", "tool:nope", "--json"]);
		expect(process.exitCode).toBe(1);
		expect(JSON.parse(out.join("\n"))[0]).toMatchObject({ status: "refused", id: "tool:nope" });
	});

	it("retires `octocode config` with the new name and a non-zero exit", async () => {
		const { err } = capture();
		expect(await handleConfigCommand(["config"])).toBe(true);
		expect(err.join("\n")).toContain("octocode configuration");
		expect(process.exitCode).toBe(1);
		expect(await handleConfigCommand(["list"])).toBe(false);
	});
});

describe("--enable, --disable and --set", () => {
	it("parses repeatable flags and rejects a --set without a value", () => {
		const parsed = parseArgs([
			"--disable",
			"tool:backlog",
			"--disable=tool:timer",
			"--enable",
			"mcp:x",
			"--set",
			"retry.maxRetries=3",
		]);
		expect(parsed).toMatchObject({
			disable: ["tool:backlog", "tool:timer"],
			enable: ["mcp:x"],
			set: ["retry.maxRetries=3"],
		});
		expect(parsed.diagnostics).toEqual([]);
		expect(parseArgs(["--set", "novalue"]).diagnostics[0]?.message).toContain("expects <key>=<value>");
	});

	it("applies at run scope in memory and leaves the files alone", async () => {
		const ctx = context(sandbox);
		const refused = await applyRunFlags(parseArgs(["--disable", "tool:backlog", "--set", "retry.maxRetries=4"]), ctx);
		expect(refused).toEqual([]);
		expect(ctx.settings.getSettings().retry?.maxRetries).toBe(4);
		expect(ctx.settings.getSettings().defaultTools).toEqual(["-backlog"]);
		expect(readJson(globalSettingsFile(sandbox))).toBeUndefined();
	});

	it("keeps run overrides through a later save and reload without ever writing them to a file", async () => {
		const ctx = context(sandbox);
		await applyRunFlags(parseArgs(["--disable", "tool:backlog", "--set", "retry.maxRetries=4"]), ctx);
		// Something else saves a setting, so settings.json exists and holds only that setting.
		ctx.settings.setTheme("dark");
		await ctx.settings.flush();
		const saved = readJson(globalSettingsFile(sandbox));
		expect(saved).toEqual({ theme: "dark" });
		const raw = readFileSync(globalSettingsFile(sandbox), "utf-8");
		await ctx.settings.reload();
		await ctx.settings.flush();
		// The overrides still apply after the reload; the file is byte-for-byte what the save wrote.
		expect(ctx.settings.getSettings().retry?.maxRetries).toBe(4);
		expect(ctx.settings.getSettings().defaultTools).toEqual(["-backlog"]);
		expect(readFileSync(globalSettingsFile(sandbox), "utf-8")).toBe(raw);
		expect(readJson(projectSettingsFile(sandbox))).toBeUndefined();
	});

	it("returns every refusal instead of ignoring a flag", async () => {
		const refused = await applyRunFlags(
			parseArgs(["--enable", "tool:nope", "--set", "no.such.key=1"]),
			context(sandbox),
		);
		expect(refused.map((result) => result.id)).toEqual(["tool:nope", "no.such.key"]);
		expect(refused[0]?.suggestions).toBeDefined();
	});
});
