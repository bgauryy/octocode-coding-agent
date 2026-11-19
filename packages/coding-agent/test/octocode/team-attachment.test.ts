import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../../src/octocode/team/attachment.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A file handed from one isolated worktree to a sibling's through `sendMessage` `attach`: sized, confined, hashed. */

type Run = {
	execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};
type Member = ReturnType<typeof fakeHost> & { team: Team; ctx: ReturnType<typeof fakeCtx>; cwd: string };
const started: Member[] = [];
function member(dbFile: string, cwd: string): Member {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	registerCollab(fake.api, team);
	const self = { ...fake, team, ctx: fakeCtx({ cwd }), cwd };
	started.push(self);
	return self;
}
const run = (tool: Run, params: unknown, ctx: unknown) => tool.execute("call-1", params, undefined, undefined, ctx);

/** Two members in linked worktrees of one repository (the sender's holds `transport.ts`), both joined. */
async function siblings() {
	const db = path.join(tmp(), "team.sqlite");
	const repo = fs.realpathSync(tmp());
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
	git("init", "-q");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
	const [wa, wb] = [
		path.join(repo, "..", `${path.basename(repo)}-a`),
		path.join(repo, "..", `${path.basename(repo)}-b`),
	];
	git("worktree", "add", "-q", "--detach", wa);
	git("worktree", "add", "-q", "--detach", wb);
	const a = member(db, fs.realpathSync(wa));
	const b = member(db, fs.realpathSync(wb));
	for (const each of [a, b]) {
		await each.emit("session_start", {}, each.ctx);
		await run(each.tools.get("coordinate") as Run, { action: "join" }, each.ctx);
	}
	fs.mkdirSync(path.join(a.cwd, "src"));
	return { a, b, send: (params: Record<string, unknown>) => run(a.tools.get("sendMessage") as Run, params, a.ctx) };
}

afterEach(async () => {
	for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
});

describe("sendMessage attach", () => {
	it("delivers the file's text with its path, size and sha256 to a sibling in another worktree", async () => {
		const { a, b, send } = await siblings();
		const content = "export const transport = 1;\n";
		fs.writeFileSync(path.join(a.cwd, "src", "transport.ts"), content);
		const sent = await send({ to: b.team.id, message: "the file you wanted", attach: "src/transport.ts" });
		expect(sent.details).toMatchObject({ to: [b.team.id] });
		const hash = createHash("sha256").update(content).digest("hex");
		await vi.waitFor(
			() => {
				const delivered = b.sent.map((entry) => String(entry.message.content)).join("\n");
				expect(delivered).toContain(`path="src/transport.ts" bytes="${content.length}" sha256="${hash}"`);
				expect(delivered).toContain(content);
			},
			{ timeout: 3_000 },
		);
	});

	it("refuses a missing file", async () => {
		const { b, send } = await siblings();
		await expect(send({ to: b.team.id, message: "x", attach: "src/none.ts" })).rejects.toThrow(
			/does not exist.*Nothing was sent/,
		);
	});

	it("refuses a file over the size limit", async () => {
		const { a, b, send } = await siblings();
		fs.writeFileSync(path.join(a.cwd, "big.txt"), "a".repeat(MAX_ATTACHMENT_BYTES + 1));
		await expect(send({ to: b.team.id, message: "x", attach: "big.txt" })).rejects.toThrow(/limit is 65536/);
	});

	it("refuses paths outside the worktree, also through a symlink or `..`", async () => {
		const { a, b, send } = await siblings();
		const outside = path.join(b.cwd, "theirs.ts");
		fs.writeFileSync(outside, "export {};\n");
		fs.symlinkSync(outside, path.join(a.cwd, "link.ts"));
		for (const attach of [outside, path.relative(a.cwd, outside), "link.ts"])
			await expect(send({ to: b.team.id, message: "x", attach })).rejects.toThrow(/outside your worktree/);
	});

	it("refuses credential files, private folders, binary files and text that holds a secret", async () => {
		const { a, b, send } = await siblings();
		fs.writeFileSync(path.join(a.cwd, ".env"), "A=1\n");
		fs.mkdirSync(path.join(a.cwd, ".octocode"), { recursive: true });
		fs.writeFileSync(path.join(a.cwd, ".octocode", "notes"), "x\n");
		fs.writeFileSync(path.join(a.cwd, "blob.bin"), Buffer.from([1, 0, 2]));
		fs.writeFileSync(path.join(a.cwd, "notes.txt"), "token: ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8\n");
		for (const [attach, why] of [
			[".env", /is private/],
			[".octocode/notes", /is private/],
			["blob.bin", /binary/],
			["notes.txt", /credential|secret/i],
		] as const)
			await expect(send({ to: b.team.id, message: "x", attach })).rejects.toThrow(why);
	});

	it("sends nothing to a recipient that has ended", async () => {
		const { a, b, send } = await siblings();
		fs.writeFileSync(path.join(a.cwd, "src", "transport.ts"), "export {};\n");
		const gone = b.team.id!;
		await b.emit("session_shutdown", {}, b.ctx);
		await expect(send({ to: gone, message: "x", attach: "src/transport.ts" })).rejects.toThrow();
	});

	it("refuses attach on a forward", async () => {
		const { b, send } = await siblings();
		await expect(send({ to: b.team.id, forward: 1, attach: "x" })).rejects.toThrow(/not a forward/);
	});
});
