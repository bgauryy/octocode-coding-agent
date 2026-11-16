import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { type InteractiveHarness, startInteractive } from "./e2e-commands-harness.ts";

/** The `/` menu as a user sees it: a real session drawn on a virtual terminal. */
describe("the slash command menu", () => {
	let t: InteractiveHarness | undefined;
	afterEach(async () => {
		await t?.stop();
		t = undefined;
	});

	const open = async (width: number) => {
		t = await startInteractive({ terminal: new VirtualTerminal(width, 40) });
		await t.until(async () => (await t!.grid()).join("").trim().length > 0, "first paint");
		return t;
	};
	const type = async (text: string) => {
		for (const ch of text) t!.press(ch);
		await new Promise((resolve) => setTimeout(resolve, 150));
	};
	/** The menu rows under the editor: each starts with the selection marker column. */
	const rows = async () =>
		(await t!.grid()).map((row) => row.trimEnd()).filter((row) => /^ {2}[› ] \S/.test(row) && !row.includes("│"));

	it("leads with getting started, tags none of Octocode's own entries and leaves out the /new aliases", async () => {
		await open(120);
		const names = (t!.host.getSlashCommands(true) as { name: string }[]).map((command) => command.name);
		expect(names).toEqual(expect.arrayContaining(["clear", "reset", "worktree"]));
		await type("/");
		const shown = await rows();
		expect(shown.map((row) => row.slice(4).split(/\s{2,}/)[0]).slice(0, 5)).toEqual([
			"help",
			"model",
			"providers",
			"effort",
			"new",
		]);
		expect(shown.join("\n")).not.toMatch(/\[t\]/);
		await type("cl");
		expect((await rows()).map((row) => row.slice(4).split(/\s{2,}/)[0])).not.toContain("clear");
	});

	it("sizes the name column from the rows in view, so a narrow terminal keeps the descriptions readable", async () => {
		await open(60);
		await type("/");
		const help = (await rows()).find((row) => row.includes("help"));
		expect(help).toBeDefined();
		// The longest name in view is `providers`: the description starts well before the 32-column skill-name width.
		expect(help!.indexOf("Find a command")).toBeLessThan(20);
	});

	it("lists /worktree's subcommands without repeating each name in its description", async () => {
		await open(120);
		await type("/worktree ");
		const list = (await rows()).find((row) => /\blist\b/.test(row));
		expect(list).toMatch(/list\s+worktrees with branch/);
		expect((await rows()).join("\n")).toMatch(/merge\s+<branch>/);
	});

	it("shows one command's usage for /help <command> and the picker for anything else", async () => {
		await open(120);
		const usage = await t!.submit("/help model");
		expect(usage.text).toMatch(/\/model · Pick a model for this chat or as the default/);
		expect(usage.text).toContain("Usage: /model [provider/model]");
		const worktree = await t!.submit("/help /worktree");
		expect(worktree.text).toMatch(/merge · <branch>/);
		const search = await t!.submit("/help sess");
		const picker = search.dialogs.join("\n");
		expect(picker).toMatch(/\/rename\s+Rename this session/);
		// The picker's name column fits its labels too, instead of a fixed 36 columns.
		expect(
			picker
				.split("\n")
				.find((row) => row.includes("/tree"))!
				.indexOf("Browse"),
		).toBeLessThan(20);
	});
});
