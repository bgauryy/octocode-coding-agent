import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb, sharedAgentDb } from "../../src/storage/database.ts";
import {
	FolderGrantRefusedError,
	grantFolder,
	listFolderGrants,
	refuseFolder,
	revokeFolder,
	revokeWorktreeGrant,
} from "../../src/octocode/trust/grants.ts";
import { folderEntry } from "../../src/octocode/trust/identity.ts";
import { acpServerHost } from "../../src/main/acp-host.ts";
import { folderTrustResolver } from "../../src/octocode/trust/port.ts";
import { resolveFolderTrust, type TrustOptions } from "../../src/octocode/trust/resolve.ts";
import { tmp } from "./helpers.ts";

/** Every case runs against its own agent database and home folder, reached the way the product reaches them: through the environment. */
let root: string;
let options: TrustOptions;
const meta = { source: "prompt", surface: "tui" } as const;

const dir = (...parts: string[]): string => {
	const folder = path.join(root, ...parts);
	fs.mkdirSync(folder, { recursive: true });
	return folder;
};
const state = (cwd: string) => resolveFolderTrust(cwd, options).state;

beforeEach(() => {
	root = fs.realpathSync(tmp("octocode-trust-"));
	const home = dir("home");
	options = { home, env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "agent.db") } };
});
afterEach(() => closeSharedAgentDb());

describe("resolveFolderTrust", () => {
	it("is undecided for a folder nobody decided about", () => {
		const cwd = dir("code", "app");
		expect(resolveFolderTrust(cwd, options)).toEqual({ state: "undecided", path: cwd, ignoredGrants: [] });
	});

	it("trusts a granted folder, with who, how and where the decision was made", () => {
		const cwd = dir("code", "app");
		grantFolder(cwd, "folder", { source: "flag", surface: "print", by: "ada" }, options);
		const result = resolveFolderTrust(cwd, options);
		expect(result).toMatchObject({
			state: "trusted",
			path: cwd,
			root: cwd,
			grant: { scope: "folder", source: "flag", path: cwd, decidedBy: "ada" },
		});
	});

	it("covers only the folder itself for a folder grant", () => {
		const cwd = dir("code", "app");
		grantFolder(cwd, "folder", meta, options);
		expect(state(dir("code", "app", "pkg"))).toBe("undecided");
		expect(state(dir("code", "other"))).toBe("undecided");
	});

	it("covers the subtree below a parent or grandparent grant, and nothing beside or above it", () => {
		const cwd = dir("code", "app", "pkg");
		const parent = grantFolder(cwd, "parent", meta, options);
		expect(parent).toMatchObject({ path: path.join(root, "code", "app"), scope: "subtree" });
		expect(resolveFolderTrust(cwd, options)).toMatchObject({ state: "trusted", root: parent.path });
		expect(state(dir("code", "app", "other", "deep", "er"))).toBe("trusted");
		expect(state(parent.path)).toBe("trusted");
		expect(state(dir("code", "sibling"))).toBe("undecided");
		expect(state(path.join(root, "code"))).toBe("undecided");

		const grand = grantFolder(cwd, "grandparent", meta, options);
		expect(grand.path).toBe(path.join(root, "code"));
		expect(state(dir("code", "sibling"))).toBe("trusted");
		// The nearest grant names the root that project instructions load from.
		expect(resolveFolderTrust(cwd, options)).toMatchObject({ root: parent.path });
	});

	it("lets a refusal on a folder stand inside a trusted subtree; it covers that folder only", () => {
		const cwd = dir("code", "app");
		grantFolder(cwd, "parent", meta, options);
		refuseFolder(cwd, meta, options);
		expect(resolveFolderTrust(cwd, options)).toMatchObject({
			state: "refused",
			root: cwd,
			grant: { source: "prompt", scope: "folder" },
		});
		// Folders below and beside it fall back to the trusted subtree they are in.
		expect(state(dir("code", "app", "pkg"))).toBe("trusted");
		expect(state(dir("code", "neighbour"))).toBe("trusted");
	});

	it("replaces a decision on the same folder, in both directions, keeping history", () => {
		const cwd = dir("code", "app");
		refuseFolder(cwd, meta, options);
		expect(state(cwd)).toBe("refused");
		grantFolder(cwd, "folder", meta, options);
		expect(state(cwd)).toBe("trusted");
		refuseFolder(cwd, meta, options);
		expect(state(cwd)).toBe("refused");
		const rows = listFolderGrants(options);
		expect(rows.map((row) => [row.decision, row.revokedBy ?? null])).toEqual([
			["refused", null],
			["trusted", "superseded"],
			["refused", "superseded"],
		]);
	});

	it("keeps one live row when the same decision is made twice", () => {
		const cwd = dir("code", "app");
		const first = grantFolder(cwd, "folder", meta, options);
		const second = grantFolder(cwd, "folder", { source: "command", surface: "cli" }, options);
		expect(second.id).toBe(first.id);
		expect(listFolderGrants(options)).toHaveLength(1);
	});

	it("converges on one live row when two connections grant the same folder", () => {
		const cwd = dir("code", "app");
		const other = openAgentDb(path.join(root, "agent.db"));
		try {
			grantFolder(cwd, "folder", meta, { ...options, db: other });
			grantFolder(cwd, "folder", meta, options);
		} finally {
			other.close();
		}
		expect(listFolderGrants(options).filter((row) => row.revokedAt === undefined)).toHaveLength(1);
	});

	it("is undecided again after a revoke, and the revoked row stays as history", () => {
		const cwd = dir("code", "app");
		const { id } = grantFolder(cwd, "folder", meta, options);
		expect(revokeFolder(id, "ada", options)).toBe(true);
		expect(revokeFolder(id, "ada", options)).toBe(false);
		expect(state(cwd)).toBe("undecided");
		expect(listFolderGrants(options)[0]).toMatchObject({ id, revokedBy: "ada" });
	});

	it("revokes a removed worktree's grant by identity, or by path once the folder is gone", () => {
		const main = dir("app");
		const alive = dir("wt", "alive");
		const gone = dir("wt", "gone");
		for (const folder of [alive, gone])
			grantFolder(folder, "folder", { source: "worktree", surface: "worktree", fromPath: main }, options);
		grantFolder(main, "folder", meta, options);
		expect(revokeWorktreeGrant(alive, "ada", options)).toBe(1);
		fs.rmSync(gone, { recursive: true });
		expect(revokeWorktreeGrant(gone, "ada", options)).toBe(1);
		expect(state(alive)).toBe("undecided");
		expect(state(main)).toBe("trusted");
	});
});

describe("folder identity", () => {
	it("treats a symlink to a trusted folder as that folder", () => {
		const real = dir("code", "app");
		const link = path.join(root, "link");
		fs.symlinkSync(real, link);
		grantFolder(real, "folder", meta, options);
		expect(resolveFolderTrust(link, options)).toMatchObject({ state: "trusted", path: real, root: real });
	});

	it("grants on the real folder when asked through a symlink", () => {
		const real = dir("code", "app");
		const linked = path.join(root, "link-to-code");
		fs.symlinkSync(path.join(root, "code"), linked);
		const granted = grantFolder(path.join(linked, "app"), "parent", meta, options);
		expect(granted.path).toBe(path.join(root, "code"));
		expect(state(real)).toBe("trusted");
	});

	it("does not follow a symlink out of a trusted folder into an untrusted one", () => {
		const trusted = dir("area", "trusted");
		const outside = dir("outside");
		fs.symlinkSync(outside, path.join(trusted, "escape"));
		grantFolder(trusted, "parent", meta, options);
		expect(state(trusted)).toBe("trusted");
		// The folder the user opens is the real one, which no grant covers.
		expect(state(path.join(trusted, "escape"))).toBe("undecided");
	});

	const insensitive = (() => {
		const probe = path.join(tmp(), "Case-Probe");
		fs.mkdirSync(probe);
		return fs.existsSync(path.join(path.dirname(probe), "case-probe"));
	})();
	it.skipIf(!insensitive)("treats the spellings of a folder on a case-insensitive disk as one", () => {
		const real = dir("Code", "App");
		grantFolder(real, "folder", meta, options);
		const lower = path.join(root, "code", "app");
		expect(resolveFolderTrust(lower, options)).toMatchObject({ state: "trusted" });
		const row = listFolderGrants(options)[0];
		expect(path.basename(row.path)).toBe("App");
	});

	it("keeps a moved folder trusted and refreshes where it is shown", () => {
		const from = dir("code", "app");
		grantFolder(from, "folder", meta, options);
		const to = path.join(root, "elsewhere", "renamed");
		fs.mkdirSync(path.dirname(to));
		fs.renameSync(from, to);
		expect(resolveFolderTrust(to, options)).toMatchObject({ state: "trusted", root: to });
		expect(listFolderGrants(options)[0].path).toBe(to);
	});

	it("keeps a moved subtree grant covering what is under it", () => {
		const from = dir("code", "app", "pkg");
		grantFolder(from, "parent", meta, options);
		const to = path.join(root, "moved");
		fs.renameSync(path.join(root, "code", "app"), to);
		expect(resolveFolderTrust(path.join(to, "pkg"), options)).toMatchObject({ state: "trusted", root: to });
	});

	it("asks again for a new folder created where a trusted one was removed", () => {
		const cwd = dir("code", "app");
		grantFolder(cwd, "folder", meta, options);
		fs.rmSync(cwd, { recursive: true });
		fs.mkdirSync(cwd);
		expect(state(cwd)).toBe("undecided");
	});

	it("rejects a reused inode whose birth time differs, and ignores a birth time the platform did not give", () => {
		const cwd = dir("code", "app");
		grantFolder(cwd, "folder", meta, options);
		const db = sharedAgentDb(options.env).db;
		db.exec("UPDATE trusted_folders SET birth = '1'");
		expect(state(cwd)).toBe("undecided");
		db.exec("UPDATE trusted_folders SET birth = '0'");
		expect(state(cwd)).toBe("trusted");
	});

	// Matching across a remount needs the birth time; a platform that reports none falls back to the device and inode.
	const hasBirth = folderEntry(tmp()).birth !== "0";
	it.skipIf(!hasBirth)(
		"keeps a folder trusted after a reboot gives its volume another device number, and stores the new one",
		() => {
			const code = dir("code");
			const cwd = dir("code", "app");
			grantFolder(cwd, "parent", meta, options);
			const db = sharedAgentDb(options.env).db;
			const before = listFolderGrants(options)[0];
			db.exec("UPDATE trusted_folders SET dev = 'before-reboot'");
			expect(resolveFolderTrust(cwd, options)).toMatchObject({ state: "trusted", root: code });
			expect(listFolderGrants(options)).toMatchObject([{ id: before.id, dev: before.dev }]);
			// Granting again after the remount keeps the one row.
			db.exec("UPDATE trusted_folders SET dev = 'before-reboot'");
			expect(grantFolder(cwd, "parent", meta, options).id).toBe(before.id);
			expect(listFolderGrants(options)).toMatchObject([{ id: before.id, dev: before.dev }]);
		},
	);

	it("asks again when the device changed and so did the path or the birth time", () => {
		const cwd = dir("code", "app");
		grantFolder(cwd, "folder", meta, options);
		const db = sharedAgentDb(options.env).db;
		db.exec("UPDATE trusted_folders SET dev = 'other', path = '/nowhere'");
		expect(state(cwd)).toBe("undecided");
		db.prepare("UPDATE trusted_folders SET path = ?, birth = '0'").run(cwd);
		expect(state(cwd)).toBe("undecided");
	});

	it("does not match by path text: a row whose stored path is wrong still matches the folder", () => {
		const cwd = dir("code", "app");
		grantFolder(cwd, "folder", meta, options);
		sharedAgentDb(options.env).db.exec("UPDATE trusted_folders SET path = '/nowhere'");
		expect(state(cwd)).toBe("trusted");
		const other = dir("code", "nowhere");
		expect(state(other)).toBe("undecided");
	});
});

describe("the home folder and filesystem roots", () => {
	it("are untrusted, never undecided, and never granted", () => {
		const home = options.home!;
		expect(resolveFolderTrust(home, options)).toMatchObject({ state: "untrusted", reason: "home" });
		expect(resolveFolderTrust(path.parse(root).root, options)).toMatchObject({
			state: "untrusted",
			reason: "filesystem-root",
		});
		for (const which of ["folder", "parent"] as const)
			expect(() => grantFolder(which === "folder" ? home : dir("home", "p"), which, meta, options)).toThrow(
				FolderGrantRefusedError,
			);
		expect(() => grantFolder(dir("home", "code", "app"), "grandparent", meta, options)).toThrow(/home folder/);
		const topLevel = path.join(path.parse(root).root, root.split(path.sep)[1]);
		expect(() => grantFolder(topLevel, "parent", meta, options)).toThrow(FolderGrantRefusedError);
		expect(() => refuseFolder(home, meta, options)).toThrow(FolderGrantRefusedError);
		expect(listFolderGrants(options)).toEqual([]);
	});

	it("still lets an unrefused folder below the home folder be decided", () => {
		const cwd = dir("home", "code", "app");
		grantFolder(cwd, "parent", meta, options);
		expect(state(cwd)).toBe("trusted");
		expect(() => grantFolder(cwd, "grandparent", meta, options)).toThrow(
			expect.objectContaining({ reason: "home", path: options.home }),
		);
	});

	it("ignores an existing grant on the home folder and reports it", () => {
		const cwd = dir("home", "code", "app");
		const database = sharedAgentDb(options.env);
		const stat = fs.lstatSync(options.home!, { bigint: true });
		database.db
			.prepare(
				"INSERT INTO trusted_folders (path, dev, ino, birth, decision, scope, source, surface, decided_by, decided_at) VALUES (?, ?, ?, '0', 'trusted', 'subtree', 'import', 'migration', 'old', 1)",
			)
			.run(options.home!, stat.dev.toString(), stat.ino.toString());
		const result = resolveFolderTrust(cwd, options);
		expect(result).toMatchObject({
			state: "undecided",
			ignoredGrants: [{ path: options.home, decision: "trusted", reason: "home" }],
		});
		expect(listFolderGrants(options)[0]).toMatchObject({ ignored: true, ignoredReason: "home" });
		// A grant of its own below the home folder works as usual.
		grantFolder(cwd, "folder", meta, options);
		expect(state(cwd)).toBe("trusted");
	});
});

describe("failures", () => {
	it("reports a missing folder instead of asking about it", () => {
		expect(resolveFolderTrust(path.join(root, "nope"), options)).toMatchObject({
			state: "untrusted",
			reason: "missing-folder",
		});
		expect(() => grantFolder(path.join(root, "nope"), "folder", meta, options)).toThrow(/does not exist/);
	});

	it("fails closed, naming the file, when the trust records cannot be read", () => {
		const bad = path.join(root, "not-a-db.db");
		fs.writeFileSync(bad, "this is not an SQLite database, it is plain text padding".repeat(10));
		const cwd = dir("code", "app");
		const broken: TrustOptions = { ...options, env: { ...process.env, OCTOCODE_AGENT_DB: bad } };
		const result = resolveFolderTrust(cwd, broken);
		expect(result).toMatchObject({ state: "untrusted", reason: "store-unavailable" });
		expect(result.state === "untrusted" && result.detail).toContain(bad);
	});

	it("tells an ACP client the cause when the records cannot be read, and offers no `trust add` that would fail the same way", () => {
		const bad = path.join(root, "acp-not-a-db.db");
		fs.writeFileSync(bad, "this is not an SQLite database, it is plain text padding".repeat(10));
		const cwd = dir("code", "acp-app");
		const before = process.env.OCTOCODE_AGENT_DB;
		process.env.OCTOCODE_AGENT_DB = bad;
		try {
			const verdict = acpServerHost.folderTrust(cwd);
			expect(verdict).toMatchObject({ trusted: false, message: expect.stringContaining(bad) });
			expect(verdict.trusted ? "trusted" : verdict.command).toBeUndefined();
		} finally {
			if (before === undefined) delete process.env.OCTOCODE_AGENT_DB;
			else process.env.OCTOCODE_AGENT_DB = before;
		}
	});
});

describe("the core port", () => {
	it("passes the stored decision through without changing it", () => {
		const cwd = dir("code", "app");
		const resolve = folderTrustResolver(options);
		expect(resolve(cwd).state).toBe("undecided");
		grantFolder(cwd, "folder", meta, options);
		expect(resolve(cwd)).toMatchObject({ state: "trusted", root: cwd });
	});
});
