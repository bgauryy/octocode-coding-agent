import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Permission } from "../../src/octocode/permission/ask.ts";
import { discardByAgent, discardChild, mergeChild } from "../../src/octocode/subagents/merge-child.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const ID = "worker-7";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const team = { members: () => [], reservation: () => undefined };

/** A repository whose HEAD lacks the commit `refs/octocode/worker-7` holds: it adds child.txt. */
function repository(): string {
	const dir = fs.realpathSync(tmp());
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	const base = git(dir, "rev-parse", "HEAD");
	fs.writeFileSync(path.join(dir, "child.txt"), "from the child\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "child");
	git(dir, "update-ref", `refs/octocode/${ID}`, "HEAD");
	git(dir, "reset", "-q", "--hard", base);
	return dir;
}

const refExists = (dir: string) => {
	try {
		git(dir, "rev-parse", "--verify", "--quiet", `refs/octocode/${ID}`);
		return true;
	} catch {
		return false;
	}
};

describe("discarding an unmerged result", () => {
	it("names the ref and its files, and keeps the ref unless confirmed", async () => {
		const dir = repository();
		const confirm = vi.fn(async () => false);
		const kept = await discardChild(team, ID, fakeCtx({ cwd: dir }), confirm);
		expect(confirm).toHaveBeenCalledWith(`refs/octocode/${ID}`, ["child.txt"]);
		expect(kept).toMatchObject({ ok: false });
		expect(refExists(dir)).toBe(true);
		const gone = await discardChild(team, ID, fakeCtx({ cwd: dir }), async () => true);
		expect(gone).toMatchObject({ ok: true });
		expect(refExists(dir)).toBe(false);
		expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(false);
	});

	it("says so when nothing is saved", async () => {
		const dir = repository();
		const confirm = vi.fn(async () => true);
		const result = await discardChild(team, "nobody-1", fakeCtx({ cwd: dir }), confirm);
		expect(result.ok).toBe(false);
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("the merge prompt", () => {
	it("names the ref and the changed files", async () => {
		const dir = repository();
		const check = vi.fn(async () => ({ allowed: false as const, message: "declined" }));
		await mergeChild(team, { check } as unknown as Permission, ID, fakeCtx(fakeCtx({ cwd: dir })));
		const asked = (check.mock.calls[0] as unknown as [unknown, { what: string[] }])[1];
		expect(asked.what.join("\n")).toContain(`refs/octocode/${ID}`);
		expect(asked.what).toContain("child.txt");
	});
});

describe("the agent discarding its own child's change", () => {
	it("asks first and keeps the ref when refused", async () => {
		const dir = repository();
		const check = vi.fn(async () => ({ allowed: false as const, message: "denied" }));
		const result = await discardByAgent(team, { check } as unknown as Permission, ID, fakeCtx({ cwd: dir }));
		expect(result.ok).toBe(false);
		expect(check).toHaveBeenCalledTimes(1);
		expect(refExists(dir)).toBe(true);
	});

	it("deletes the ref once allowed", async () => {
		const dir = repository();
		const check = vi.fn(async () => ({ allowed: true as const }));
		const result = await discardByAgent(team, { check } as unknown as Permission, ID, fakeCtx({ cwd: dir }));
		expect(result.ok).toBe(true);
		expect(refExists(dir)).toBe(false);
		expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(false);
	});
});

describe("merging into a checkout with uncommitted work", () => {
	const allow = { check: vi.fn(async () => ({ allowed: true as const })) } as unknown as Permission;

	it("refuses naming the dirty file it would change, keeping the ref and the work", async () => {
		const dir = repository();
		fs.writeFileSync(path.join(dir, "child.txt"), "my own work\n");
		const head = git(dir, "rev-parse", "HEAD");
		const result = await mergeChild(team, allow, ID, fakeCtx({ cwd: dir }));
		expect(result.ok).toBe(false);
		expect(result.text).toContain("child.txt");
		expect(refExists(dir)).toBe(true);
		expect(git(dir, "rev-parse", "HEAD")).toBe(head);
		expect(fs.readFileSync(path.join(dir, "child.txt"), "utf8")).toBe("my own work\n");
	});

	it("drops the ref when its change is already in the tree, keeping the other uncommitted work", async () => {
		const dir = repository();
		fs.writeFileSync(path.join(dir, "child.txt"), "from the child\n");
		fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
		const check = vi.fn(async () => ({ allowed: true as const }));
		const result = await mergeChild(team, { check } as unknown as Permission, ID, fakeCtx({ cwd: dir }));
		expect(result.ok).toBe(true);
		expect(result.text).toContain("already in this tree");
		expect(check).not.toHaveBeenCalled();
		expect(refExists(dir)).toBe(false);
		expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("edited\n");
	});

	it("merges when only unrelated files are dirty", async () => {
		const dir = repository();
		fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
		const result = await mergeChild(team, allow, ID, fakeCtx({ cwd: dir }));
		expect(result.ok).toBe(true);
		expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(true);
		expect(refExists(dir)).toBe(false);
	});
});
