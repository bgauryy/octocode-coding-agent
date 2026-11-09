import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTrustCommand } from "../../src/cli/trust-command.ts";
import type { ExtensionCommandContext } from "../../src/core/features/index.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { trust, closeSharedAgentDb } from "../../../db/src/api.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registerTrustCommand } from "../../src/octocode/trust/command.ts";
import { grantFolder, listFolderGrants, refuseFolder } from "../../src/octocode/trust/grants.ts";
import { folderEntry } from "../../src/octocode/trust/identity.ts";
import { resolveFolderTrust, type TrustOptions } from "../../src/octocode/trust/resolve.ts";
import { tmp } from "./helpers.ts";

let root: string;
let home: string;
let options: TrustOptions;

const dir = (...parts: string[]): string => {
	const folder = path.join(root, ...parts);
	fs.mkdirSync(folder, { recursive: true });
	return folder;
};
const live = () => listFolderGrants(options).filter((row) => row.revokedAt === undefined);
const state = (cwd: string) => resolveFolderTrust(cwd, options).state;

beforeEach(() => {
	root = fs.realpathSync(tmp("octocode-trust-command-"));
	home = dir("home");
	options = { home, env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "agent.db") } };
});
afterEach(() => closeSharedAgentDb());

/** A slash-command context: the answers a user would give, and everything shown to them. */
function session(
	cwd: string,
	answers: { confirm?: boolean[]; select?: Array<string | undefined>; hasUI?: boolean } = {},
) {
	const shown: string[] = [];
	const dialogs: string[] = [];
	const confirm = [...(answers.confirm ?? [])];
	const select = [...(answers.select ?? [])];
	const shutdown = vi.fn();
	const ctx = {
		cwd,
		hasUI: answers.hasUI ?? true,
		shutdown,
		ui: {
			notify: (text: string) => void shown.push(text),
			confirm: async (title: string, message: string) => (
				dialogs.push(`${title}\n${message}`),
				confirm.shift() ?? false
			),
			select: async (title: string, choices: string[]) => (
				dialogs.push(`${title}\n${choices.join("\n")}`),
				select.shift()
			),
		},
	} as unknown as ExtensionCommandContext;
	const commands = new Subcommands();
	registerTrustCommand(commands, options);
	const run = (args: string) => commands.get("trust")!.handler(args, ctx);
	return { run, shown, dialogs, shutdown, text: () => shown.join("\n") };
}

describe("/trust", () => {
	it("is one command with no aliases, described briefly", () => {
		const commands = new Subcommands();
		registerTrustCommand(commands, options);
		const trustCommand = commands.get("trust")!;
		expect(commands.list().map(([name]) => name)).toEqual(["trust"]);
		expect(trustCommand.description.length).toBeLessThanOrEqual(50);
		expect(trustCommand.argumentHint).toBe("[list|add|remove]");
	});

	it("completes its subcommands as the editor offers them after /trust", () => {
		const commands = new Subcommands();
		registerTrustCommand(commands, options);
		const registered = new Map<string, { getArgumentCompletions?: (prefix: string) => unknown }>();
		commands.register({
			registerCommand: (name: string, command: never) => registered.set(name, command),
			on: vi.fn(),
		} as never);
		const complete = registered.get("trust")!.getArgumentCompletions!;
		const values = (prefix: string) => (complete(prefix) as Array<{ value: string }> | null)?.map((item) => item.value);
		expect(values("")).toEqual(["list", "add", "remove"]);
		expect(values("a")).toEqual(["add"]);
		expect(values("re")).toEqual(["remove"]);
		expect(values("x")).toBeUndefined();
		// Through the command table (Octocode's own `/octocode`-style entry), each value carries the command name.
		expect(commands.complete("trust ")?.map((item) => item.value)).toEqual(["trust list", "trust add", "trust remove"]);
	});

	it("lists grants, refusals and ignored root grants with path, scope, source and date", async () => {
		const app = dir("code", "app");
		const bad = dir("code", "bad");
		grantFolder(app, "parent", { source: "prompt", surface: "tui", by: "ada" }, options);
		refuseFolder(bad, { source: "prompt", surface: "tui", by: "ada" }, options);
		// A grant on the home folder cannot be written, so an old one is planted the way an import would have.
		trust.decide(
			sharedAgentDb(options.env).db,
			{
				...folderEntry(home),
				decision: "trusted",
				scope: "subtree",
				source: "import",
				surface: "migration",
				decidedBy: "ada",
			},
			Date.now(),
		);
		const t = session(app);
		await t.run("list");
		// Local date and time, the way the user reads a clock.
		const now = new Date();
		const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
			.map((part) => String(part).padStart(2, "0"))
			.join("-");
		expect(t.text()).toContain(`${path.join(root, "code")} and everything under it`);
		expect(t.text()).toMatch(
			new RegExp(
				`trusted .*${path.join(root, "code")}\\s+subtree \u00b7 prompt \u00b7 ada \u00b7 ${date} \\d{2}:\\d{2}`,
			),
		);
		expect(t.text()).toMatch(/refused .*bad\s+this folder \u00b7 prompt/);
		expect(t.text()).toMatch(/ignored .*home folder: a grant here would cover every project/);
	});

	it("adds the current folder after a confirmation that says what trust allows", async () => {
		const app = dir("code", "app");
		const t = session(app, { select: ["Trust"] });
		await t.run("add");
		expect(t.dialogs[0]).toMatch(/run commands[\s\S]*this folder/);
		expect(live()).toMatchObject([
			{ path: app, scope: "folder", source: "command", surface: "tui", decision: "trusted" },
		]);
		expect(state(app)).toBe("trusted");
	});

	it("records nothing when the confirmation is declined", async () => {
		const app = dir("code", "app");
		const t = session(app, { select: ["Cancel"] });
		await t.run("add");
		expect(live()).toEqual([]);
		expect(t.text()).toContain("Nothing was changed.");
	});

	it("adds a parent as a subtree and turns a recorded refusal back into trust", async () => {
		const app = dir("code", "app", "web");
		refuseFolder(app, { source: "prompt", surface: "tui" }, options);
		const t = session(app, { select: ["Trust", "Trust"] });
		await t.run("add --scope parent");
		expect(live().find((row) => row.path === path.dirname(app))).toMatchObject({ scope: "subtree", source: "command" });
		// The refusal on the folder itself is nearer, so it still stands until it is replaced.
		expect(state(app)).toBe("refused");
		await t.run(`add ${app}`);
		expect(state(app)).toBe("trusted");
	});

	it("refuses the home folder and the root with a suggestion to open a project", async () => {
		const t = session(dir("code", "app"), { select: ["Trust"] });
		await t.run(`add ${home}`);
		expect(t.text()).toMatch(/does not open your home folder[\s\S]*Open a project folder/);
		await t.run(`add ${path.join(home, "x")} --scope parent`.replace(path.join(home, "x"), dir("home", "x")));
		expect(live()).toEqual([]);
	});

	it("does not trust without a terminal unless --yes is given", async () => {
		const app = dir("code", "app");
		const t = session(app, { hasUI: false });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await t.run("add");
			expect(live()).toEqual([]);
			await t.run("add --yes");
			expect(live()).toMatchObject([{ path: app, surface: "print", source: "command" }]);
		} finally {
			stderr.mockRestore();
		}
	});

	it("removes an entry by number or by folder, and says it asks again", async () => {
		const a = dir("code", "a");
		const b = dir("code", "b");
		const first = grantFolder(a, "folder", { source: "prompt", surface: "tui" }, options);
		grantFolder(b, "folder", { source: "prompt", surface: "tui" }, options);
		const t = session(dir("elsewhere"), { select: ["Remove", "Remove"] });
		await t.run(`remove #${first.id}`);
		await t.run(`remove ${b}`);
		expect(live()).toEqual([]);
		expect(state(a)).toBe("undecided");
		expect(t.dialogs[0]).toContain("ask again the next time");
		expect(t.shutdown).not.toHaveBeenCalled();
	});

	it("closes the session when the removed decision is the one that lets it run", async () => {
		const app = dir("code", "app");
		grantFolder(app, "folder", { source: "prompt", surface: "tui" }, options);
		const t = session(app, { select: ["Remove"] });
		await t.run("remove .".replace(".", app));
		expect(t.dialogs[0]).toContain("Octocode will close");
		expect(t.shutdown).toHaveBeenCalledOnce();
		expect(state(app)).toBe("undecided");
	});

	it("says so when nothing matches", async () => {
		const t = session(dir("code", "app"));
		await t.run("remove 99");
		expect(t.text()).toContain("No trust decision is stored for 99");
	});

	it("opens a menu of entries and wider folders; choosing an entry offers to remove it", async () => {
		const app = dir("code", "app", "web");
		grantFolder(app, "folder", { source: "prompt", surface: "tui" }, options);
		const gone = dir("other");
		grantFolder(gone, "folder", { source: "command", surface: "cli" }, options);
		const probe = session(app, { select: [undefined] });
		await probe.run("");
		const menu = probe.dialogs[0] ?? "";
		expect(menu).toContain("Folder trust");
		expect(menu).toContain(`Trust ${path.dirname(app)} and everything under it`);
		const entry = menu.split("\n").find((line) => line.includes(gone));
		const t = session(app, { select: [entry, "Remove"] });
		await t.run("");
		expect(live().map((row) => row.path)).toEqual([app]);
		const wider = session(app, { select: [`Trust ${path.dirname(app)} and everything under it`, "Trust"] });
		await wider.run("");
		expect(live().find((row) => row.path === path.dirname(app))).toMatchObject({ scope: "subtree" });
	});

	it("prints usage for an unknown subcommand", async () => {
		const t = session(dir("code", "app"));
		await t.run("frobnicate");
		expect(t.text()).toContain("Usage: /trust");
	});
});

describe("octocode trust", () => {
	const cli = (cwd: string, args: string[], confirm?: (question: string) => Promise<boolean>) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = runTrustCommand(args, { cwd, options, out: (t) => out.push(t), err: (t) => err.push(t), confirm });
		return code.then((exit) => ({ exit, out: out.join("\n"), err: err.join("\n") }));
	};

	it("adds with --yes for scripts, records it as a command from the CLI, and lists it as JSON", async () => {
		const app = dir("code", "app");
		expect(await cli(app, ["add", "--yes"])).toMatchObject({ exit: 0, out: `Trusted ${app}.` });
		const listed = JSON.parse((await cli(app, ["list", "--json"])).out);
		expect(listed).toMatchObject([
			{ path: app, decision: "trusted", scope: "folder", source: "command", surface: "cli" },
		]);
		expect((await cli(app, ["add", "--yes"])).out).toContain("already trusted");
	});

	it("asks first on a terminal, and exits 1 without recording when declined", async () => {
		const app = dir("code", "app");
		const question = vi.fn(async () => false);
		expect(await cli(app, ["add"], question)).toMatchObject({ exit: 1, err: "Nothing was changed." });
		expect(question).toHaveBeenCalledWith(`Trust ${app}?`);
		expect(live()).toEqual([]);
		expect((await cli(app, ["add"], async () => true)).exit).toBe(0);
		expect(state(app)).toBe("trusted");
	});

	it("exits 1 with no terminal and no --yes", async () => {
		const result = await cli(dir("code", "app"), ["add"], undefined);
		expect(result.exit).toBe(1);
		expect(result.err).toContain("--yes");
		expect(live()).toEqual([]);
	});

	it("trusts a path, a parent or a grandparent as a subtree", async () => {
		const web = dir("mono", "packages", "web");
		expect((await cli(root, ["add", web, "--scope", "grandparent", "--yes"])).exit).toBe(0);
		expect(live()).toMatchObject([{ path: path.join(root, "mono"), scope: "subtree" }]);
		expect(state(web)).toBe("trusted");
	});

	it("refuses the home folder, with the message shown at startup", async () => {
		const result = await cli(home, ["add", "--yes"]);
		expect(result.exit).toBe(1);
		expect(result.err).toMatch(/does not open your home folder[\s\S]*Open a project folder/);
		expect(live()).toEqual([]);
	});

	it("removes by number or path, and a removed folder asks again", async () => {
		const app = dir("code", "app");
		await cli(app, ["add", "--yes"]);
		expect(await cli(app, ["remove", app, "--yes"])).toMatchObject({ exit: 0 });
		expect(state(app)).toBe("undecided");
		expect((await cli(app, ["remove", "7", "--yes"])).exit).toBe(1);
	});

	it("rejects unknown options and subcommands", async () => {
		expect((await cli(root, ["add", "--force"])).exit).toBe(1);
		expect((await cli(root, ["add", "--scope", "cousin"])).exit).toBe(1);
		expect((await cli(root, ["frob"])).err).toContain("Unknown trust command frob");
		expect((await cli(root, ["help"])).out).toContain("trust remove");
	});
});
