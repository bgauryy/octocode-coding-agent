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
		});
		await fake.commands.get("status")!.handler("", ctx);
		expect(ctx.ui.notes).toHaveLength(1);
		const text = ctx.ui.notes[0].message;
		expect(text).toMatch(/^Octocode 1\.0\n\nSkills/);
		expect(text).toContain("MCPs (");
		expect(text).toContain("Tokens");
		expect(text).toContain("Cached: 50");
		expect(text).toContain("Cost");
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
