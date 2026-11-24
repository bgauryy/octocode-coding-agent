import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentReferences, MAX_ATTACHMENT_BYTES } from "../../src/octocode/team/attachment.ts";
import { attachmentContent } from "../../src/octocode/team/attachment-source.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import type { PeerRoute } from "../../src/octocode/team/tools/messages.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A file handed from one isolated worktree to a sibling's through `sendMessage` `attach`: sized, confined, hashed. */

type Run = {
	execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};
type Member = ReturnType<typeof fakeHost> & { team: Team; ctx: ReturnType<typeof fakeCtx>; cwd: string };
const started: Member[] = [];
function member(dbFile: string, cwd: string, peers?: PeerRoute): Member {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	registerCollab(fake.api, team, peers ? { peers } : {});
	const self = { ...fake, team, ctx: fakeCtx({ cwd }), cwd };
	started.push(self);
	return self;
}
const run = (tool: Run, params: unknown, ctx: unknown) => tool.execute("call-1", params, undefined, undefined, ctx);

/** Two members in linked worktrees of one repository (the sender's holds `transport.ts`), both joined. */
async function siblings(peers?: PeerRoute) {
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
	const a = member(db, fs.realpathSync(wa), peers);
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

/** The team mail `member` received, as the session entries its file tool reads delivered attachments from. */
function mailEntries(member: Member) {
	return member.sent
		.filter((entry) => entry.message.customType === "octocode-agent-message")
		.map((entry, index) => ({ type: "custom_message", id: `mail-${index}`, ...entry.message }));
}

/** `member`'s file tool, in a context whose session holds the mail it received. */
function recipientFile(member: Member) {
	const host = fakeHost();
	registerFileTool(host.api, new FileGuard(), fakePermission(), undefined, undefined, attachmentContent);
	const ctx = fakeCtx({ cwd: member.cwd });
	Object.assign(ctx, {
		sessionManager: { ...(ctx as { sessionManager: object }).sessionManager, getBranch: () => mailEntries(member) },
	});
	return (queries: Record<string, unknown>[]) =>
		run(host.tools.get("file") as Run, { reason: "take the attachment", queries }, ctx);
}

/** Sends `src/transport.ts` from a to b and waits for b to receive the reference. */
async function attached(content = "export const transport = 1;\n") {
	const pair = await siblings();
	fs.writeFileSync(path.join(pair.a.cwd, "src", "transport.ts"), content);
	const sent = await pair.send({ to: pair.b.team.id, message: "the file you wanted", attach: "src/transport.ts" });
	const hash = createHash("sha256").update(content).digest("hex");
	await vi.waitFor(() => expect(mailEntries(pair.b).length).toBeGreaterThan(0));
	const texts = mailEntries(pair.b).flatMap((entry) =>
		(entry.details as { messages: Array<{ text: string }> }).messages.map((message) => message.text),
	);
	const [reference] = attachmentReferences(texts.join("\n"));
	return { ...pair, content, hash, sent, reference, write: recipientFile(pair.b) };
}

describe("sendMessage attach", () => {
	it("delivers a reference with path, size and sha256 to a sibling in another worktree, not the text", async () => {
		const { b, content, hash, sent } = await attached();
		expect(sent.details).toMatchObject({ to: [b.team.id] });
		const delivered = b.sent.map((entry) => String(entry.message.content)).join("\n");
		expect(delivered).toContain(`path="src/transport.ts" bytes="${content.length}" sha256="${hash}" saved="`);
		expect(delivered).toContain(`fromAttachment: "${hash}"`);
		expect(delivered).not.toContain(content);
		expect(delivered.indexOf("<attachment")).toBeLessThan(delivered.indexOf("the file you wanted"));
	});

	it("saves the bytes content-addressed, and the recipient's file tool writes them by hash", async () => {
		const { b, content, hash, reference, write } = await attached();
		expect(path.basename(reference.saved)).toBe(`attachment-${hash}.txt`);
		expect(fs.readFileSync(reference.saved, "utf8")).toBe(content);
		const result = await write([{ type: "write", path: "src/transport.ts", fromAttachment: hash }]);
		expect(result.content[0].text).toContain(`sourceSha256=${hash}`);
		expect(fs.readFileSync(path.join(b.cwd, "src", "transport.ts"), "utf8")).toBe(content);
	});

	it("writes only an attachment delivered to this session", async () => {
		const { b, write } = await attached();
		const other = createHash("sha256").update("never sent").digest("hex");
		await expect(write([{ type: "write", path: "x.ts", fromAttachment: other }])).rejects.toThrow(
			/No attachment with sha256 .* reached this session/,
		);
		expect(fs.existsSync(path.join(b.cwd, "x.ts"))).toBe(false);
	});

	it("asks for a resend when the saved copy is gone or changed, and writes nothing", async () => {
		const { b, hash, reference, write } = await attached();
		fs.writeFileSync(reference.saved, "tampered\n");
		await expect(write([{ type: "write", path: "y.ts", fromAttachment: hash }])).rejects.toThrow(
			/changed since it was sent\. Ask its sender to send it again/,
		);
		fs.rmSync(reference.saved);
		await expect(write([{ type: "write", path: "y.ts", fromAttachment: hash }])).rejects.toThrow(
			/is gone\. Ask its sender to send it again/,
		);
		expect(fs.existsSync(path.join(b.cwd, "y.ts"))).toBe(false);
	});

	it("refuses fromAttachment beside content or on an edit", async () => {
		const { hash, write } = await attached();
		await expect(write([{ type: "write", path: "z.ts", content: "x", fromAttachment: hash }])).rejects.toThrow(
			/not both/,
		);
		await expect(
			write([{ type: "edit", path: "z.ts", edits: [{ oldText: "a", newText: "b" }], fromAttachment: hash }]),
		).rejects.toThrow(/goes with a write query/);
	});

	it("refuses fromAttachment in a file tool given no attachment reader, and writes nothing", async () => {
		const { b, hash } = await attached();
		const host = fakeHost();
		registerFileTool(host.api, new FileGuard(), fakePermission());
		const ctx = fakeCtx({ cwd: b.cwd });
		Object.assign(ctx, {
			sessionManager: { ...(ctx as { sessionManager: object }).sessionManager, getBranch: () => mailEntries(b) },
		});
		const queries = [{ type: "write", path: "w.ts", fromAttachment: hash }];
		await expect(run(host.tools.get("file") as Run, { reason: "take it", queries }, ctx)).rejects.toThrow(
			/fromAttachment needs team mail/,
		);
		expect(fs.existsSync(path.join(b.cwd, "w.ts"))).toBe(false);
	});

	it("refuses attach to another Octocode process, which has no file tool route for it", async () => {
		const peers: PeerRoute = {
			addresses: (to) => to === "other-process",
			send: async () => ({ text: "sent", details: {} }),
			list: async () => "",
		};
		const { a, send } = await siblings(peers);
		fs.writeFileSync(path.join(a.cwd, "src", "transport.ts"), "export {};\n");
		await expect(send({ to: "other-process", message: "x", attach: "src/transport.ts" })).rejects.toThrow(
			/attach reaches teammates only/,
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
