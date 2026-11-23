import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinDescription, BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { HintBar } from "../../src/theme/theme-tui-helpers.ts";
import { ThinkingSelectorComponent } from "../../src/modes/interactive/components/thinking-selector.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { statusCommand } from "../../src/octocode/status-command.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

beforeAll(() => initTheme("dark"));

describe("/status", () => {
	it("prints one message holding the native report and the session's token, cache and cost totals", async () => {
		const fake = fakeHost();
		const commands = new Subcommands();
		commands.add(
			"status",
			statusCommand(fake.api, { mode: "full" }, () => "Octocode 1.0"),
		);
		commands.register(fake.api);
		const sessionManager = SessionManager.inMemory(process.cwd());
		sessionManager.appendMessage({
			...fauxAssistantMessage("reply"),
			usage: {
				input: 100,
				output: 5,
				cacheRead: 50,
				cacheWrite: 0,
				totalTokens: 155,
				cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
			},
		});
		const ctx = Object.assign(fakeCtx({ cwd: ".", hasUI: true }), {
			sessionManager,
			getContextUsage: () => undefined,
			getCacheWarmingReport: () => ["Cache Warming", "Mode: idle", "Status: Inactive (provider billed by plan)"],
		});
		await fake.commands.get("status")!.handler("", ctx);
		expect(ctx.ui.notes).toHaveLength(1);
		const text = ctx.ui.notes[0].message;
		expect(text).toMatch(/^Octocode 1\.0\n\nSkills/);
		// The section the cache docs point at, after the cache totals.
		expect(text).toContain("Cache Warming\nMode: idle\nStatus: Inactive (provider billed by plan)");
		expect(text.indexOf("Cache Warming")).toBeGreaterThan(text.indexOf("Cached: 50"));
		expect(text).toContain("MCPs (");
		expect(text).toContain("Tokens");
		expect(text).toContain("Cached: 50");
		expect(text).toContain("Cost");
		// No refresh ran: the line says so instead of a bare $0.000.
		expect(text).toContain("Recorded refresh usage: none\n");
		expect(text).not.toContain("$0.000");
	});

	it("names the model, counts messages that add up, writes money as the footer does and singular counts, and ends on the report", async () => {
		const fake = fakeHost();
		const commands = new Subcommands();
		commands.add(
			"status",
			statusCommand(fake.api, { mode: "full" }, () => "Octocode 1.0"),
		);
		commands.register(fake.api);
		const sessionManager = SessionManager.inMemory(process.cwd());
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		sessionManager.appendMessage({
			...fauxAssistantMessage("reply"),
			usage: {
				input: 1_200,
				output: 7,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_207,
				cost: { input: 0.0036, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0037 },
			},
		});
		sessionManager.appendMessage({
			role: "bashExecution",
			command: "ls",
			output: "",
			exitCode: 0,
			timestamp: 2,
		} as never);
		const ctx = Object.assign(fakeCtx({ cwd: ".", hasUI: true }), {
			sessionManager,
			getContextUsage: () => undefined,
			model: { provider: "faux", id: "faux-1", reasoning: false },
		});
		await fake.commands.get("status")!.handler("", ctx);
		const text = ctx.ui.notes[0].message;
		expect(text).toContain("Model: faux/faux-1\n");
		// 1 user + 1 assistant + 0 tool results + 1 other = 3.
		expect(text).toMatch(/Total: 3\nUser: 1\nAssistant: 1\nTool results: 0 \(0 calls\)\nOther: 1\n/);
		expect(text).toContain("(1 request)");
		expect(text).not.toContain("1 requests");
		// An estimate at list prices, as the footer and /usage write it.
		expect(text).toMatch(/Cost\nTotal: ≈\$<0\.01\n/);
		expect(text).toContain("MCPs (0)\n  none · /mcp adds one");
		// The report is the last section: no orphan line after it.
		expect(text).not.toContain("Configure servers with /mcp.");
		expect(text.trimEnd().split("\n").at(-1)).toMatch(/Turn 1: ≈\$0\.0037/);
	});
});

describe("/status Live status", () => {
	it("labels a status by its name without the octocode- prefix, marks a warning with its glyph, and never repeats a label", async () => {
		const { statusReportLine } = await import("../../src/modes/interactive/interactive-mode/footer-status-report.ts");
		expect(statusReportLine("octocode-backlog", { text: "/web · backlogs & activity" })).toBe(
			"backlog: /web · backlogs & activity",
		);
		// The glyph and the word: the severity stays readable when copied, read aloud or shown without colour
		// (`footer-status-report.test.ts` pins the textual label).
		expect(statusReportLine("octocode-permission", { text: "⏵⏵ permission: full · shift+tab", tone: "warning" })).toBe(
			"⚠ WARNING · ⏵⏵ permission: full · shift+tab",
		);
		expect(statusReportLine("mcp", { text: "1 of 2 failed", tone: "error" })).toBe("✗ ERROR · mcp: 1 of 2 failed");
	});
});

describe("one description per command", () => {
	it("a native registration shows the built-in text it was given", () => {
		for (const name of ["permissions", "agents", "plan", "status", "resume", "modelsettings"])
			expect(builtinDescription(name), name).toBe(BUILTIN_SLASH_COMMANDS.find((c) => c.name === name)?.description);
		expect(() => builtinDescription("no-such-command")).toThrow("not a built-in command");
	});
});

describe("selector hints", () => {
	it("the thinking selector ends in a HintBar line that fits a narrow width", () => {
		const selector = new ThinkingSelectorComponent(
			"low",
			["low", "high"],
			() => undefined,
			() => undefined,
			() => undefined,
		);
		expect(selector.children.some((child) => child instanceof HintBar)).toBe(true);
		const lines = selector.render(30);
		expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(30);
		expect(stripAnsi(lines.join("\n"))).toContain("esc");
	});
});
