/** `/messages` is one registered word with one description and no Claude Code alias; the team panel names the real recipient. */
import { describe, expect, it, vi } from "vitest";
import type { Traffic } from "@octocodeai/octocode-contracts/team";
import {
	builtinDescription,
	COMMAND_ALIASES,
	getBuiltinCommand,
	parseSlashCommand,
	reservedCommandNames,
	SLASH_MENU_ORDER,
} from "../../src/core/slash-commands.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registerMessagesCommand } from "../../src/octocode/team/messages/command.ts";
import { messageBlock } from "../../src/octocode/team/panel/traffic.ts";
import { theme } from "./fake-host.ts";

describe("the /messages command", () => {
	it("is a built-in word with one description, in the menu, and no alias takes its name or points at it", () => {
		const command = getBuiltinCommand("messages");
		expect(command?.requiresNative).toBe(true);
		expect(command?.description.length).toBeLessThanOrEqual(50);
		expect(SLASH_MENU_ORDER).toContain("messages");
		// Claude Code has no /messages: nothing maps to it, and the name is not an alias of another command.
		expect(COMMAND_ALIASES.has("messages")).toBe(false);
		expect([...COMMAND_ALIASES.values()]).not.toContain("messages");
		expect(parseSlashCommand("/messages internal")).toEqual({ name: "messages", args: "internal" });
		expect(reservedCommandNames([]).has("messages")).toBe(true);
	});

	it("registers under that name with the built-in description and argument", () => {
		const commands = new Subcommands();
		registerMessagesCommand(commands, () => ({
			feed: { traffic: () => [], directory: () => ({ members: [] }) },
			transcript: () => undefined,
		}));
		const registered = commands.get("messages");
		expect(registered?.description).toBe(builtinDescription("messages"));
		expect(registered?.argumentWords).toEqual(getBuiltinCommand("messages")?.argumentValues);
		expect(registered?.dialog).toBe("interaction");
	});

	it("refuses an argument it does not know without opening the team database", async () => {
		const commands = new Subcommands();
		registerMessagesCommand(commands, () => ({
			feed: { traffic: () => [], directory: () => ({ members: [] }) },
			transcript: () => undefined,
		}));
		const notify = vi.fn();
		await commands.get("messages")!.handler("bogus", { hasUI: true, ui: { notify } } as never);
		expect(notify).toHaveBeenCalledWith("Usage: /messages [internal]", "warning");
	});
});

describe("team panel message head", () => {
	const message: Traffic = {
		id: 12,
		from: "alpha",
		to: ["beta"],
		text: "check the tests",
		at: Date.now() - 12_000,
		state: "awaiting reply",
		toEndpoints: [{ id: "beta", role: "researcher", worktree: "worktree fix", branch: "fix/x", tmuxPane: "%2" }],
	};

	it("names the real recipient with role, worktree and tmux marks", () => {
		const [head] = messageBlock(message, Date.now(), theme, 160, "│");
		expect(head).toContain("✉ #12 → beta(researcher) · worktree fix · fix/x · tmux pane %2 · awaiting reply");
		expect(head).not.toContain("you");
	});

	it("keeps the bare id when the recipient was not resolved", () => {
		const { toEndpoints: _unresolved, ...bare } = message;
		expect(messageBlock(bare, Date.now(), theme, 160, "│")[0]).toContain("✉ #12 → beta · awaiting reply");
	});

	it("shows the first recipient with its marks and a count when there are more than two", () => {
		const many: Traffic = {
			...message,
			to: ["beta", "gamma", "delta"],
			toEndpoints: [{ id: "beta", role: "researcher" }, { id: "gamma" }, { id: "delta" }],
		};
		expect(messageBlock(many, Date.now(), theme, 160, "│")[0]).toContain("→ beta(researcher) +2 · awaiting reply");
	});
});
