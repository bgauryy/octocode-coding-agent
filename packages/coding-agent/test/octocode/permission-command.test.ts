import type * as PageModule from "../../src/octocode/shared/page.ts";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { registerPermissionCommand } from "../../src/octocode/permission/command.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { registerEditor } from "../../src/octocode/ui/editor.ts";
const page = vi.hoisted(() => ({ show: vi.fn(async (): Promise<{ id: string } | undefined> => undefined) }));
vi.mock("../../src/octocode/shared/page.ts", async (original) => ({
	...(await original<typeof PageModule>()),
	showCommandPage: page.show,
}));

import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

function setup(options: { trusted?: boolean; env?: NodeJS.ProcessEnv; confirms?: boolean[] } = {}) {
	const fake = fakeHost();
	// Sessions start in full; these fixtures export workspace, or manual for the strict (`trusted: false`) case.
	const permission = new Permission({
		api: fake.api,
		env: options.env ?? { OCTOCODE_PERMISSION: options.trusted === false ? "manual" : "workspace" },
		isSubagent: false,
	});
	const commands = new Subcommands();
	registerPermissionCommand(commands, permission, () => 42);
	registerEditor(fake.api, permission);
	const ctx = Object.assign(fakeCtx({ cwd: tmp(), ui: { confirms: options.confirms ?? [] } }), {
		isProjectTrusted: () => options.trusted ?? true,
	});
	// Audit entries come back from the session, as Octocode keeps them.
	ctx.sessionManager.getEntries = (() => fake.entries.map((entry) => ({ type: "custom", ...entry }))) as never;
	// Raw terminal input and the editor's text, as Octocode's TUI gives them to an extension.
	let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let text = "";
	Object.assign(ctx.ui, {
		onTerminalInput: (handler: typeof input) => {
			input = handler;
			return () => {
				input = undefined;
			};
		},
		getEditorText: () => text,
	});
	ctx.ui.setEditorComponent(() => ({
		render: () => [],
		invalidate: () => undefined,
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		handleInput: () => undefined,
	}));
	permission.start(ctx);
	void fake.emit("session_start", { type: "session_start" }, ctx);
	const run = (args: string) => commands.get("permissions")!.handler(args, ctx);
	/** Tab with `typed` in the input line; returns whether Octocode took the key (else the editor completes as usual). */
	const tab = async (typed = ""): Promise<boolean> => {
		text = typed;
		const taken = input?.("\t")?.consume === true;
		await new Promise((resolve) => setImmediate(resolve));
		return taken;
	};
	const cycle = () => ctx.ui.editor({} as never, {} as never, new KeybindingsManager()).handleInput?.("\u001b[Z");
	return { fake, permission, ctx, run, tab, cycle };
}

describe("/permissions and editor shortcut", () => {
	it("opens a list page with the modes and the views; leaving it changes nothing", async () => {
		const { permission, run } = setup();
		page.show.mockClear();
		await run("");
		const options = (
			page.show.mock.calls[0] as unknown as [unknown, { sections: Array<{ rows: Array<{ id: string }> }> }]
		)[1];
		expect(options.sections.flatMap((section) => section.rows.map((row) => row.id))).toEqual([
			"mode:manual",
			"mode:workspace",
			"mode:full",
			"open:status",
			"open:grants",
			"open:log",
		]);
		expect(permission.mode).toBe("workspace");
	});

	it("applies the mode picked on the page and shows the view picked on it", async () => {
		const { permission, run, ctx } = setup();
		page.show.mockResolvedValueOnce({ id: "mode:manual" });
		await run("");
		expect(permission.mode).toBe("manual");
		page.show.mockResolvedValueOnce({ id: "open:grants" });
		await run("");
		expect(ctx.ui.notes.at(-1)!.message).toBe("Session grants: none");
	});

	it("starts in full; the editor shortcut cycles full → workspace → manual → full", async () => {
		const { permission, cycle, ctx } = setup({ env: {} });
		expect(permission.mode).toBe("full");
		expect(ctx.ui.statuses.get("octocode-permission")).toBe("⏵⏵ permission: full · shift+tab");
		await cycle();
		expect(permission.mode).toBe("workspace");
		await cycle();
		expect(permission.mode).toBe("manual");
		await cycle();
		expect(permission.mode).toBe("full");
	});

	it("leaves Tab to the editor while something is typed (path completion)", async () => {
		const { permission, tab } = setup({ env: {} });
		expect(await tab("src/perm")).toBe(false);
		expect(permission.mode).toBe("full");
	});

	it("leaves selector Tab untouched when the main editor is empty", async () => {
		const { permission, tab } = setup({ env: { OCTOCODE_PERMISSION: "manual" } });
		expect(await tab()).toBe(false);
		expect(permission.mode).toBe("manual");
	});

	it("switches to any mode by command, full included, without a trust check or confirmation", async () => {
		const { permission, run, ctx } = setup({ trusted: false, env: { [PERMISSION_ENV]: "manual" } });
		await run("full");
		expect(permission.mode).toBe("full");
		expect(ctx.ui.confirms).toEqual([]);
	});

	it("shows the mode, what it asks for, the grants and the provenance index", async () => {
		const { run, ctx } = setup();
		await run("status");
		const shown = ctx.ui.notes.at(-1)!.message;
		expect(shown).toMatch(/^Permission mode: workspace/);
		expect(shown).toContain("file.outside: ask");
		expect(shown).toContain("shell: allow");
		expect(shown).toContain("shell.destructive: ask");
		expect(shown).toContain("browser.control: ask");
		expect(shown).toContain("hook.ask: ask");
		expect(shown).toContain("provenance: ask");
		expect(shown).toContain("Session grants: none");
		expect(shown).toContain("Provenance index: 42");
		expect(shown).toMatch(/not a sandbox/);
	});

	it("lists and clears grants, and shows the audit log", async () => {
		const { run, ctx, permission } = setup({ trusted: false });
		ctx.ui.selects.push("Allow `ls` for this session");
		await permission.check(ctx, {
			action: "shell",
			title: "Run?",
			what: ["ls"],
			grant: { key: "ls", label: "`ls`" },
		});
		await run("grants");
		expect(ctx.ui.notes.at(-1)!.message).toContain("shell: `ls`");
		await run("grants clear");
		expect(permission.grants()).toEqual([]);
		await run("workspace");
		await run("log");
		const log = ctx.ui.notes.at(-1)!.message;
		expect(log).toMatch(/manual main shell allowed \(user\) ls/);
		expect(log).toMatch(/mode manual → workspace/);
		await run("bogus");
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			type: "warning",
			message: expect.stringContaining("Usage: /permissions"),
		});
	});

	it("says how many earlier decisions a long audit log leaves out", async () => {
		const { run, ctx, permission } = setup({ env: {} });
		for (let i = 0; i < 53; i++) permission.setMode(i % 2 === 0 ? "manual" : "full", ctx);
		await run("log");
		const lines = ctx.ui.notes.at(-1)!.message.split("\n");
		expect(lines[0]).toBe("(3 earlier decision(s) not shown; the session file keeps them all)");
		expect(lines).toHaveLength(51);
	});

	it("keeps headless status and mode-change feedback visible without writing to stdout", async () => {
		const { run, ctx } = setup();
		Object.assign(ctx, { hasUI: false, mode: "print" });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await run("");
			expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("Permission mode: workspace"));
			await run("manual");
			// One sentence, as /permissions shows it: the summary follows a dash, not a full stop before a lowercase word.
			expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("Permission mode: manual — it asks before"));
			expect(stdout).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
			stdout.mockRestore();
		}
	});
});
