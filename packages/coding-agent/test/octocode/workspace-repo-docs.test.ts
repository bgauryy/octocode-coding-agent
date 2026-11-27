import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_DIR } from "../../src/storage/agent-layout.ts";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import { handleDocsRequest } from "../../src/octocode/workspace/docs.ts";
import { readRepoDocFile, readRepoDocsIndex } from "../../src/octocode/workspace/repo-docs.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.reverse()) close();
	cleanup.length = 0;
});

const tmp = (prefix: string): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): { root: string; outside: string } {
	const root = tmp("repo-docs-");
	const outside = tmp("repo-docs-outside-");
	const write = (relative: string, content: string) => {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	};
	git(root, "init", "-q");
	write("README.md", "# Readme\n");
	write("docs/guide.md", "# Guide\n\nbody");
	write("notes.txt", "not markdown");
	write(".octocode/plans/p.md", "# Authored\n");
	write("node_modules/pkg/README.md", "# Dep\n");
	fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n");
	fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md"));
	fs.symlinkSync(outside, path.join(root, "linked-dir"));
	git(
		root,
		"add",
		"-f",
		"README.md",
		"docs/guide.md",
		"notes.txt",
		"link.md",
		"linked-dir",
		".octocode/plans/p.md",
		"node_modules",
	);
	write("untracked.md", "# Untracked\n");
	return { root, outside };
}

async function call(root: string, route: string, trusted: boolean) {
	let answer: { status: number; body: any } | undefined;
	const handled = await handleDocsRequest(
		{ method: "GET" } as IncomingMessage,
		new URL(route, "http://127.0.0.1"),
		root,
		(status, body) => (answer = { status, body }),
		() => trusted,
	);
	expect(handled).toBe(true);
	return answer!;
}

it("lists only tracked Markdown, as regular files, outside .octocode and node_modules", async () => {
	const { root } = repo();
	expect((await readRepoDocsIndex(root)).map((doc) => doc.path).sort()).toEqual([
		"@repo/README.md",
		"@repo/docs/guide.md",
	]);
	const guide = (await readRepoDocsIndex(root)).find((doc) => doc.path === "@repo/docs/guide.md");
	expect(guide).toMatchObject({ title: "Guide", topic: "docs" });
});

it("lists repository documents beside .octocode docs for a trusted project and hides them otherwise", async () => {
	const { root } = repo();
	fs.mkdirSync(path.join(root, AGENT_DIR, "plans"), { recursive: true });
	fs.writeFileSync(path.join(root, AGENT_DIR, "plans", "p.md"), "# Authored\n");
	const trusted = await call(root, "/api/docs", true);
	expect(trusted.status).toBe(200);
	expect(trusted.body.docs.map((doc: { path: string }) => doc.path).sort()).toEqual([
		"@repo/README.md",
		"@repo/docs/guide.md",
		"plans/p.md",
	]);
	expect(trusted.body.repoDocsHidden).toBeUndefined();
	const untrusted = await call(root, "/api/docs", false);
	expect(untrusted.body.docs.map((doc: { path: string }) => doc.path)).toEqual(["plans/p.md"]);
	expect(untrusted.body.repoDocsHidden).toBe(true);
});

it("serves a tracked document when trusted and refuses every fetch when untrusted", async () => {
	const { root } = repo();
	const route = `/api/docs/file?path=${encodeURIComponent("@repo/docs/guide.md")}`;
	const ok = await call(root, route, true);
	expect(ok.status).toBe(200);
	expect(ok.body.markdown).toContain("# Guide");
	expect((await call(root, route, false)).status).toBe(403);
});

it("refuses untracked files, traversal, absolute paths and symlinks out of the root", async () => {
	const { root } = repo();
	for (const attempt of [
		"@repo/untracked.md",
		"@repo/../secret.md",
		"@repo/docs/../../x.md",
		"@repo//etc/passwd.md",
		"@repo//etc/passwd",
		"@repo/link.md",
		"@repo/linked-dir/secret.md",
		"@repo/notes.txt",
		"@repo/.octocode/plans/p.md",
		"@repo/node_modules/pkg/README.md",
		"@repo/docs\\guide.md",
		"@repo/docs/guide.md\0.txt",
		"README.md",
	])
		expect(await readRepoDocFile(root, attempt), attempt).toBeUndefined();
	expect((await readRepoDocFile(root, "@repo/README.md"))?.markdown).toBe("# Readme\n");
	const route = `/api/docs/file?path=${encodeURIComponent("@repo/untracked.md")}`;
	expect((await call(root, route, true)).status).toBe(404);
});

it("refuses a tracked document that is swapped for a symlink out of the root", async () => {
	const { root, outside } = repo();
	fs.rmSync(path.join(root, "README.md"));
	fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "README.md"));
	expect(await readRepoDocFile(root, "@repo/README.md")).toBeUndefined();
	expect((await readRepoDocsIndex(root)).map((doc) => doc.path)).not.toContain("@repo/README.md");
});

it("lists nothing outside a git repository", async () => {
	const dir = tmp("repo-docs-nogit-");
	fs.writeFileSync(path.join(dir, "a.md"), "# A\n");
	expect(await readRepoDocsIndex(dir)).toEqual([]);
});
