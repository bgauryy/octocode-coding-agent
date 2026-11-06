import { describe, expect, it } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import type { PermissionRequest } from "../../src/octocode/permission/request.ts";
import { PERMISSION_ENV, PERMISSION_GRANTS_ENV, PERMISSION_NONCE_FILE_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { nonceFile } from "./nonce-file.ts";

const shell = (command = "npm test"): PermissionRequest => ({
	action: "shell",
	title: "Run this command?",
	what: [command],
	grant: { key: command, label: `\`${command}\`` },
});

function setup(
	options: {
		env?: NodeJS.ProcessEnv;
		isSubagent?: boolean;
		trusted?: boolean;
		hasUI?: boolean;
		selects?: Array<string | undefined>;
		inputs?: Array<string | undefined>;
	} = {},
) {
	const fake = fakeHost();
	// Sessions start in full; these fixtures export workspace, or manual for the strict (`trusted: false`) case.
	const permission = new Permission({
		api: fake.api,
		env: options.env ?? { OCTOCODE_PERMISSION: options.trusted === false ? "manual" : "workspace" },
		isSubagent: options.isSubagent ?? false,
	});
	const ctx = {
		...fakeCtx({
			cwd: tmp(),
			hasUI: options.hasUI ?? true,
			ui: { selects: options.selects ?? [], inputs: options.inputs ?? [] },
		}),
		isProjectTrusted: () => options.trusted ?? true,
	};
	permission.start(ctx);
	return { fake, permission, ctx };
}

describe("Permission.check", () => {
	it("allows what the mode allows without a dialog, and audits it as mode", async () => {
		const { permission, ctx, fake } = setup();
		expect(permission.mode).toBe("workspace");
		expect(await permission.check(ctx, shell())).toEqual({ allowed: true, via: "mode", lasts: "call" });
		expect(ctx.ui.selects).toEqual([]);
		// Every call that reaches a check is audited, the allowed ones too.
		expect(fake.entries).toEqual([
			{
				customType: "octocode-permission",
				data: expect.objectContaining({
					action: "shell",
					what: ["npm test"],
					allowed: true,
					via: "mode",
					mode: "workspace",
					agent: "main",
				}),
			},
		]);
	});

	it("asks in manual, and an answer is audited", async () => {
		const { permission, ctx, fake } = setup({ trusted: false, selects: ["Allow once"] });
		expect(permission.mode).toBe("manual");
		expect(await permission.check(ctx, shell())).toEqual({ allowed: true, via: "user", lasts: "call" });
		expect(fake.entries).toEqual([
			{
				customType: "octocode-permission",
				data: expect.objectContaining({
					action: "shell",
					what: ["npm test"],
					allowed: true,
					via: "user",
					mode: "manual",
				}),
			},
		]);
	});

	it('remembers "allow for this session" for exactly what was shown', async () => {
		const { permission, ctx } = setup({ trusted: false, selects: ["Allow `npm test` for this session"] });
		expect(await permission.check(ctx, shell())).toEqual({ allowed: true, via: "user", lasts: "session" });
		// No reply is queued: a second dialog would be dismissed and deny.
		expect(await permission.check(ctx, shell())).toEqual({ allowed: true, via: "grant", lasts: "session" });
		expect(permission.grants()).toEqual(["shell: `npm test`"]);
		expect((await permission.check(ctx, shell("npm publish"))).allowed).toBe(false);
		permission.clearGrants();
		expect(permission.grants()).toEqual([]);
	});

	it("adds the user's note to a denial, and tells the model not to retry", async () => {
		const { permission, ctx } = setup({
			trusted: false,
			selects: ["Deny and tell the agent why…"],
			inputs: ["use yarn"],
		});
		const verdict = await permission.check(ctx, shell());
		expect(verdict).toMatchObject({ allowed: false, via: "user" });
		expect(verdict.allowed ? "" : verdict.message).toMatch(
			/denied .*npm test.*Do not retry[\s\S]*User's note: use yarn/,
		);
	});

	it("shows controls in the action named in a denial or headless refusal as visible escapes", async () => {
		const denied = setup({ trusted: false, selects: ["Deny"] });
		const verdict = await denied.permission.check(denied.ctx, shell("echo \u001b[2J\u202e"));
		expect(verdict.allowed ? "" : verdict.message).toContain("denied the shell command: echo \\u{1b}[2J\\u{202e}.");
		const headless = setup({ trusted: false, hasUI: false });
		const refused = await headless.permission.check(headless.ctx, {
			...shell("echo \u001b[2J"),
			reason: "from \u0007web",
		});
		const message = refused.allowed ? "" : refused.message;
		expect(message).toContain("(echo \\u{1b}[2J)");
		expect(message).toContain("Why it asks: from \\u{7}web.");
		expect(message).not.toMatch(/[\u001b\u0007]/u);
	});

	it("treats a dismissed or aborted dialog as no verdict", async () => {
		const dismissed = setup({ trusted: false, selects: [undefined] });
		expect(await dismissed.permission.check(dismissed.ctx, shell())).toEqual({
			allowed: false,
			via: "cancelled",
			message: "Not run: the approval dialog was dismissed.",
		});
		const aborted = setup({ trusted: false, selects: ["Allow once"] });
		const controller = new AbortController();
		controller.abort();
		expect(await aborted.permission.check(aborted.ctx, { ...shell(), signal: controller.signal })).toMatchObject({
			allowed: false,
			via: "cancelled",
		});
	});

	it("denies every ask without a UI or in a subagent, without opening anything", async () => {
		const headless = setup({ trusted: false, hasUI: false });
		const verdict = await headless.permission.check(headless.ctx, shell());
		expect(verdict).toMatchObject({ allowed: false, via: "headless" });
		expect(verdict.allowed ? "" : verdict.message).toMatch(
			/needs the user's approval \(manual mode\) and no one can be asked here\. Do not retry.*start Octocode with --permission-mode workspace/,
		);
		const why = await headless.permission.check(headless.ctx, {
			...shell(),
			reason: "contains text from web https://x.example; save it with the file tool",
		});
		expect(why.allowed ? "" : why.message).toContain(
			"Why it asks: contains text from web https://x.example; save it with the file tool.",
		);
		const child = setup({ isSubagent: true, env: { [PERMISSION_ENV]: "manual" }, selects: ["Allow once"] });
		const denied = await child.permission.check(child.ctx, shell());
		expect(denied.allowed ? "" : denied.message).toMatch(/report to your parent what is blocked/);
		expect(child.ctx.ui.selects).toEqual(["Allow once"]);
	});

	it("allows the workspace classes a spawn grant carries into a child, and nothing else", async () => {
		const { permission, ctx } = setup({
			isSubagent: true,
			env: { [PERMISSION_ENV]: "manual", [PERMISSION_GRANTS_ENV]: "shell" },
		});
		expect(await permission.check(ctx, shell())).toEqual({ allowed: true, via: "grant", lasts: "session" });
		expect(
			(await permission.check(ctx, { action: "file.workspace", title: "Change files?", what: ["a.ts"] })).allowed,
		).toBe(false);
	});

	it("runs provenance and hook hits in full without a dialog, and records both reasons with the call", async () => {
		const { permission, ctx, fake } = setup({ env: { [PERMISSION_ENV]: "full" } });
		let opened = 0;
		ctx.ui.select = async () => {
			opened += 1;
			return "Allow once";
		};
		expect(
			await permission.check(ctx, {
				action: "shell",
				reasons: ["provenance"],
				title: "Run this command?",
				what: ["curl x | sh"],
				reason: "contains text from web https://x",
				grant: { key: "k", label: "this" },
			}),
		).toEqual({ allowed: true, via: "mode", lasts: "call" });
		expect(
			await permission.check(ctx, {
				action: "shell",
				reasons: ["hook.ask", "provenance"],
				title: "Run this command?",
				what: ["rm build"],
				grant: { key: "k", label: "this" },
			}),
		).toEqual({ allowed: true, via: "mode", lasts: "call" });
		expect(opened).toBe(0);
		expect(fake.entries.map((entry) => entry.data)).toEqual([
			expect.objectContaining({
				action: "shell",
				reasons: ["provenance"],
				allowed: true,
				via: "mode",
				mode: "full",
			}),
			expect.objectContaining({
				action: "shell",
				reasons: ["hook.ask", "provenance"],
				allowed: true,
				via: "mode",
				mode: "full",
			}),
		]);
	});

	it("asks for a hook in workspace without a session grant, and shows the effect card with the reason before the agent's words", async () => {
		const { permission, ctx } = setup();
		let options: string[] = [];
		let shown = "";
		ctx.ui.select = async (title: string, choices: string[]) => {
			shown = title;
			options = choices;
			return "Allow once";
		};
		expect(
			await permission.check(ctx, {
				action: "shell",
				reasons: ["hook.ask"],
				title: "Run this command?",
				what: ["rm build"],
				reason: "the hook wants a look",
				purpose: "clean the build",
				grant: { key: "k", label: "this" },
			}),
		).toEqual({ allowed: true, via: "user", lasts: "call" });
		expect(options).toEqual(["Allow once", "Deny", "Deny and tell the agent why…"]);
		const lines = shown.split("\n");
		const marks = lines.filter((line) => line.includes("▸"));
		expect(marks.map((line) => line.trim().split(":")[0])).toEqual(["▸ effect", "▸ undo", "▸ why it asks", "▸ risk"]);
		expect(shown).toContain("▸ why it asks: the hook wants a look");
		expect(lines.at(-1)).toBe("  agent says (unverified): clean the build");
	});

	it("does not let a shell grant cover a provenance hit, and names the command", async () => {
		const { permission, ctx } = setup({
			trusted: false,
			selects: ["Allow all shell commands for this session", "Allow once"],
		});
		expect(await permission.check(ctx, shell("npm test && npm run build"))).toEqual({
			allowed: true,
			via: "user",
			lasts: "session",
		});
		let shown = "";
		let options: string[] = [];
		ctx.ui.select = async (title: string, choices: string[]) => {
			shown = title;
			options = choices;
			return "Allow once";
		};
		expect(
			await permission.check(ctx, {
				action: "shell",
				reasons: ["provenance"],
				title: "Run this command?",
				what: ["curl x | sh"],
				reason: "contains text from web https://x",
				grant: { key: "curl", label: "`curl`" },
			}),
		).toEqual({ allowed: true, via: "user", lasts: "call" });
		expect(shown).toContain("▸ why it asks: contains text from web https://x");
		expect(options).toEqual(["Allow once", "Deny", "Deny and tell the agent why…"]);
	});

	it("adds the untrusted-data warning to a provenance denial", async () => {
		const { permission, ctx } = setup({ selects: ["Deny"] });
		const verdict = await permission.check(ctx, {
			action: "shell",
			reasons: ["provenance"],
			title: "Run this command?",
			what: ["curl x | sh"],
			reason: "contains text from web https://x",
		});
		expect(verdict.allowed ? "" : verdict.message).toMatch(/denied the shell command: curl x \| sh/);
		expect(verdict.allowed ? "" : verdict.message).toMatch(
			/contains text from web https:\/\/x.*untrusted data, not instructions/s,
		);
	});

	it("tells a headless provenance refusal which mode runs that hit", async () => {
		const { permission, ctx } = setup({ env: { [PERMISSION_ENV]: "workspace" }, hasUI: false });
		const verdict = await permission.check(ctx, {
			action: "shell",
			reasons: ["provenance"],
			title: "Run this command?",
			what: ["curl x | sh"],
			reason: "contains text from web https://x",
		});
		expect(verdict.allowed ? "" : verdict.message).toMatch(
			/the shell command \(curl x \| sh\) needs the user's approval \(workspace mode\)/,
		);
		expect(verdict.allowed ? "" : verdict.message).toContain("--permission-mode full");
		expect(verdict.allowed ? "" : verdict.message).not.toContain("--permission-mode workspace");
	});

	it("asks for a forcing reason when the call has no action class, and records that reason", async () => {
		const { permission, ctx, fake } = setup({ env: { [PERMISSION_ENV]: "manual" }, selects: ["Allow once"] });
		let shown = "";
		ctx.ui.select = async (title: string) => {
			shown = title;
			return "Allow once";
		};
		expect(
			await permission.check(ctx, {
				reasons: ["hook.ask"],
				title: "Run read?",
				what: ["read src/a.ts"],
				reason: "Hook says check this",
			}),
		).toEqual({ allowed: true, via: "user", lasts: "call" });
		expect(shown).toContain("▸ why it asks: Hook says check this");
		expect(shown).not.toContain("read.outside");
		expect(fake.entries).toEqual([
			{
				customType: "octocode-permission",
				data: expect.objectContaining({ action: "call", reasons: ["hook.ask"], allowed: true, via: "user" }),
			},
		]);
	});

	it("shows one dialog at a time: a second ask waits for the first", async () => {
		const { permission, ctx } = setup({ trusted: false });
		const order: string[] = [];
		let release!: (value: string) => void;
		ctx.ui.select = (async (title: string) => {
			order.push(`open ${title.split("\n")[1]}`);
			if (order.length === 1)
				return new Promise((resolve) => {
					release = resolve;
					return release;
				});
			return "Allow once";
		}) as never;
		const first = permission.check(ctx, shell("one"));
		const second = permission.check(ctx, shell("two"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual(["open   one"]);
		release("Allow once");
		await Promise.all([first, second]);
		expect(order).toEqual(["open   one", "open   two"]);
	});

	it("runs a custom dialog in place of the default one, with the same mode and headless rules", async () => {
		const { permission, ctx } = setup({ trusted: false });
		let shown = 0;
		const dialog = async () => {
			shown += 1;
			return "once" as const;
		};
		expect(await permission.check(ctx, { action: "file.workspace", title: "Apply?", what: ["a.ts"] }, dialog)).toEqual({
			allowed: true,
			via: "user",
			lasts: "call",
		});
		permission.setMode("workspace", ctx);
		expect(await permission.check(ctx, { action: "file.workspace", title: "Apply?", what: ["a.ts"] }, dialog)).toEqual({
			allowed: true,
			via: "mode",
			lasts: "call",
		});
		expect(shown).toBe(1);
	});
});

describe("Permission modes over a session", () => {
	it("clears grants on every session start, and takes the stricter of the current and the exported start mode", async () => {
		const { permission, ctx } = setup({ trusted: false, selects: ["Allow `npm test` for this session"] });
		await permission.check(ctx, shell());
		expect(permission.grants()).not.toEqual([]);
		permission.start(ctx);
		expect(permission.mode).toBe("manual");
		expect(permission.grants()).toEqual([]);
		// Exported `manual` bounds a wider choice, and says so.
		permission.setMode("workspace", ctx);
		permission.start(ctx);
		expect(permission.mode).toBe("manual");
		expect(ctx.ui.notes.map((note) => note.message).join("\n")).toMatch(
			/Permission mode is manual again: the start mode \(--permission-mode or OCTOCODE_PERMISSION\) bounds .* \/permissions workspace widens this one/,
		);
	});

	it("does not flip the default: the first start is the start mode, `full` with nothing exported", () => {
		const { permission } = setup({ env: {} });
		expect(permission.mode).toBe("full");
	});

	it("with nothing exported keeps a chosen mode over a later start, narrow or full, and notices nothing", () => {
		const { permission, ctx } = setup({ env: {} });
		permission.setMode("manual", ctx);
		permission.start(ctx);
		expect(permission.mode).toBe("manual");
		permission.setMode("full", ctx);
		permission.start(ctx);
		expect(permission.mode).toBe("full");
		expect(ctx.ui.notes.map((note) => note.message).join("\n")).not.toMatch(/again/);
	});

	it("with `full` exported keeps a narrower choice, which is the stricter one", () => {
		const { permission, ctx } = setup({ env: { [PERMISSION_ENV]: "full" } });
		permission.setMode("workspace", ctx);
		permission.start(ctx);
		expect(permission.mode).toBe("workspace");
	});

	/** `/new`, `/resume`, `/fork` and `/reload` run the feature again on the same process environment: a new `Permission`. */
	function replaced(env: NodeJS.ProcessEnv, reason: "startup" | "reload" | "new" | "resume" | "fork") {
		const fake = fakeHost();
		const stderr: string[] = [];
		const permission = new Permission({ api: fake.api, env, isSubagent: false, stderr: (text) => stderr.push(text) });
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true, ui: { selects: [], inputs: [] } });
		permission.start(ctx, reason);
		return { permission, ctx, stderr };
	}

	it.each(["new", "resume", "fork", "reload"] as const)(
		"carries the chosen mode into the runtime `/%s` builds",
		(reason) => {
			const env: NodeJS.ProcessEnv = {};
			const first = replaced(env, "startup");
			expect(first.permission.mode).toBe("full");
			first.permission.setMode("manual", first.ctx);
			expect(replaced(env, reason).permission.mode).toBe("manual");
			// `/permissions full` is a choice too, and it stays.
			const next = replaced(env, reason);
			next.permission.setMode("full", next.ctx);
			expect(replaced(env, reason).permission.mode).toBe("full");
		},
	);

	it("reverts a wider choice in the next runtime when the start mode is exported, with a notice", () => {
		const env: NodeJS.ProcessEnv = { [PERMISSION_ENV]: "workspace" };
		const first = replaced(env, "startup");
		first.permission.setMode("full", first.ctx);
		const next = replaced(env, "new");
		expect(next.permission.mode).toBe("workspace");
		expect(next.ctx.ui.notes.map((note) => note.message).join("\n")).toMatch(/is workspace again/);
	});

	it("a process's first start takes the start mode, whatever an earlier harness left in another environment", () => {
		const left: NodeJS.ProcessEnv = {};
		replaced(left, "startup").permission.setMode("manual", fakeCtx({ cwd: tmp(), hasUI: false }));
		expect(replaced({}, "new").permission.mode).toBe("full");
		expect(replaced(left, "startup").permission.mode).toBe("full");
	});

	it("switches to full anywhere, and warns once about an invalid OCTOCODE_PERMISSION (which starts in manual)", () => {
		const { permission, ctx } = setup({ trusted: false, env: { [PERMISSION_ENV]: "loose" } });
		expect(permission.mode).toBe("manual");
		permission.setMode("full", ctx);
		expect(permission.mode).toBe("full");
		permission.start(ctx);
		expect(ctx.ui.notes.filter((note) => note.message.includes("loose"))).toHaveLength(1);
	});

	it("tells the model once per change, hidden and without starting a turn", () => {
		const { permission, ctx, fake } = setup();
		permission.setMode("manual", ctx);
		permission.setMode("manual", ctx);
		expect(fake.sent).toEqual([
			{
				message: expect.objectContaining({
					customType: "octocode-permission",
					display: false,
					content: expect.stringMatching(/^\[octocode-permission\] mode is now manual: /),
				}),
				options: { triggerTurn: false },
			},
		]);
		expect(ctx.ui.statuses.get("octocode-permission")).toBe("⏸ permission: manual · shift+tab");
	});
});

describe("Permission.noted", () => {
	it("audits a fact no check decided, with its verdict, source and one-line note", () => {
		const { permission, fake } = setup();
		permission.noted(["PreToolUse hook hooks/guard.sh", "bash"], "timed out after 10s;\nthe call went on", {
			allowed: true,
			via: "hook",
		});
		permission.noted(["PreToolUse hook hooks/guard.sh"], "invalid JSON", { allowed: false, via: "hook" });
		permission.noted(["ws://10.0.0.5:9000"], "page opened a WebSocket to a private address", {
			allowed: true,
			via: "reported",
			action: "invariant",
			tool: "browser",
		});
		expect(fake.entries.map((entry) => entry.data)).toEqual([
			expect.objectContaining({
				action: "call",
				what: ["PreToolUse hook hooks/guard.sh", "bash"],
				allowed: true,
				via: "hook",
				note: "timed out after 10s;⏎the call went on",
				agent: "main",
			}),
			expect.objectContaining({ action: "call", allowed: false, via: "hook", note: "invalid JSON" }),
			expect.objectContaining({
				action: "invariant",
				what: ["ws://10.0.0.5:9000"],
				allowed: true,
				via: "reported",
				note: "browser: page opened a WebSocket to a private address",
			}),
		]);
	});
});

describe("Permission in a subagent whose Octocode reports a UI (RPC)", () => {
	it("shows nothing to a person: no warning notification and no mode notification, only the hidden message", () => {
		const { permission, ctx } = setup({
			isSubagent: true,
			env: { [PERMISSION_ENV]: "loose", [PERMISSION_NONCE_FILE_ENV]: nonceFile("n0nce") },
		});
		permission.setMode("full", ctx);
		// Its audit entry goes to the parent as a notify the parent never draws (see the relay tests), with the child's nonce.
		expect(ctx.ui.notes.filter((note) => !note.message.startsWith("octocode-audit/1 "))).toEqual([]);
		expect(ctx.ui.notes).toEqual([
			{ message: expect.stringMatching(/^octocode-audit\/1 \{.*"action":"mode".*"nonce":"n0nce"/), type: "info" },
		]);
	});
});
