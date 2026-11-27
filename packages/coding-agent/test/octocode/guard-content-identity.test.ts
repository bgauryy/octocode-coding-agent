import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../../../db/src/api.ts";
import { loadSkillFromFile } from "../../src/core/skills/load-dir.ts";
import { hookItem, mcpItem, skillItem } from "../../src/octocode/guard/items.ts";
import { scan } from "../../src/octocode/guard/scan.ts";
import { decide, gate, resolveReviews } from "../../src/octocode/guard/store.ts";
import type { ReviewItem } from "../../src/octocode/guard/types.ts";
import { tmp } from "./helpers.ts";

let root: string;
let db: AgentDb;
beforeEach(() => {
	root = tmp("octocode-guard-content-");
	db = openDatabase({
		file: path.join(root, "agent.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
});
afterEach(() => {
	db.close();
	fs.rmSync(root, { recursive: true, force: true });
});

function approved(item: ReviewItem): string {
	const [review] = resolveReviews([item], { db });
	decide(review, "approved", "test", { db });
	return review.hash;
}

function changed(item: ReviewItem, oldHash: string): void {
	const result = gate(item.kind, [item], { db, enforce: true });
	expect(result.allowed.has(item.id)).toBe(false);
	expect(result.reviews[0]).toMatchObject({ word: "not checked", changed: true });
	expect(scan(item).hash).not.toBe(oldHash);
}

it.each(['"./a hook.cjs"', "'./a hook.cjs'", "./a\\ hook.cjs"])(
	"pins the script named by a quoted or escaped hook path (%s)",
	(argument) => {
		const script = path.join(root, "a hook.cjs");
		const command = `node ${argument}`;
		const item = () =>
			hookItem({
				id: "hook:quoted",
				source: path.join(root, "hooks.json"),
				event: "PreToolUse",
				matcher: "Bash",
				position: 0,
				type: "command",
				definition: { command },
				command,
				label: command,
				scope: "fixture-project",
				cwd: root,
			});
		fs.writeFileSync(script, "first contents");
		const hash = approved(item());
		fs.writeFileSync(script, "changed contents");
		changed(item(), hash);
	},
);

it("pins the linked SKILL.md bytes that the actual skill loader reads", () => {
	const dir = path.join(root, "linked-skill");
	fs.mkdirSync(dir);
	const target = path.join(root, "target.md");
	const file = path.join(dir, "SKILL.md");
	const content = (description: string) => `---\nname: linked-skill\ndescription: ${description}\n---\nInstructions`;
	fs.writeFileSync(target, content("first description"));
	fs.symlinkSync(target, file);
	const loaded = loadSkillFromFile(file, "project").skill;
	expect(loaded?.filePath).toBe(file);
	const item = () => skillItem({ name: "linked-skill", filePath: file, scope: "fixture-project" });
	const hash = approved(item());
	fs.writeFileSync(target, content("changed description"));
	expect(loadSkillFromFile(file, "project").skill?.description).toBe("changed description");
	changed(item(), hash);
});

it("pins linked sidecar files without expanding linked directory trees", () => {
	const dir = path.join(root, "skill");
	fs.mkdirSync(dir);
	const file = path.join(dir, "SKILL.md");
	fs.writeFileSync(file, "Run helper.cjs");
	const target = path.join(root, "helper.cjs");
	fs.writeFileSync(target, "first contents");
	fs.symlinkSync(target, path.join(dir, "helper.cjs"));
	const item = () => skillItem({ name: "skill", filePath: file, scope: "fixture-project" });
	const hash = approved(item());
	fs.writeFileSync(target, "changed contents");
	changed(item(), hash);
	fs.symlinkSync(root, path.join(dir, "linked-directory"));
	const [review] = resolveReviews([item()], { db });
	expect(review.item.unreadable).toMatch(/linked.directory/i);
	expect(() => decide(review, "approved", "test", { db })).toThrow(/not read in full/);
});

it("refuses a linked file that exceeds the existing folder byte limit", () => {
	const dir = path.join(root, "large-skill");
	fs.mkdirSync(dir);
	const target = path.join(root, "large.md");
	fs.writeFileSync(target, Buffer.alloc(8 * 1024 * 1024 + 1, "x"));
	const file = path.join(dir, "SKILL.md");
	fs.symlinkSync(target, file);
	const [review] = resolveReviews([skillItem({ name: "large", filePath: file, scope: "fixture-project" })], { db });
	expect(review.item.unreadable).toMatch(/bytes/);
	expect(() => decide(review, "approved", "test", { db })).toThrow(/not read in full/);
});

const server = (env: Record<string, string>) =>
	mcpItem({
		name: "fixture",
		source: "mcp.json",
		scope: "fixture-project",
		config: { command: "node", args: ["server.cjs"], env },
	});

it("withholds an already approved folder when a new directory link cannot be reviewed", () => {
	const dir = path.join(root, "approved-skill");
	fs.mkdirSync(dir);
	const file = path.join(dir, "SKILL.md");
	fs.writeFileSync(file, "Instructions");
	const item = () => skillItem({ name: "approved", filePath: file, scope: "fixture-project" });
	approved(item());
	fs.symlinkSync(root, path.join(dir, "z-linked-directory"));
	const result = gate("skill", [item()], { db, enforce: true });
	expect(result.reviews[0].item.unreadable).toBeDefined();
	expect(result.allowed.size).toBe(0);
	expect(result.reviews[0]).toMatchObject({ word: "not checked", changed: true });
});

it("invalidates approval when the file limit leaves the same previously reviewed prefix", () => {
	const dir = path.join(root, "full-skill");
	fs.mkdirSync(dir);
	const file = path.join(dir, "SKILL.md");
	fs.writeFileSync(file, "Instructions");
	for (let index = 0; index < 499; index++) fs.writeFileSync(path.join(dir, `part-${index}.txt`), "content");
	const item = () => skillItem({ name: "full", filePath: file, scope: "fixture-project" });
	const hash = approved(item());
	fs.writeFileSync(path.join(dir, "zzz-extra.cjs"), "not previously reviewed");
	const partial = item();
	expect(scan(partial).hash).toBe(hash);
	expect(partial.unreadable).toMatch(/500 files/);
	const result = gate("skill", [partial], { db, enforce: true });
	expect(result.allowed.size).toBe(0);
	expect(result.reviews[0]).toMatchObject({ word: "not checked", changed: true });
});

it.each(["NODE_OPTIONS", "PATH"])("pins the configured execution selector %s without revealing its value", (name) => {
	const hash = approved(server({ [name]: "first-private-value" }));
	const item = server({ [name]: "changed-private-value" });
	changed(item, hash);
	expect(JSON.stringify(item)).not.toContain("changed-private-value");
});

it("preserves literal credential rotation and pins unresolved executable expressions", () => {
	expect(scan(server({ API_TOKEN: "first-secret" })).hash).toBe(scan(server({ API_TOKEN: "rotated-secret" })).hash);
	expect(JSON.stringify(server({ API_TOKEN: "first-secret" }))).not.toContain("first-secret");
	expect(scan(server({ NODE_OPTIONS: "$(FIRST_OPTIONS)" })).hash).not.toBe(
		scan(server({ NODE_OPTIONS: "$(SECOND_OPTIONS)" })).hash,
	);
	expect(scan(server({ API_TOKEN: "!first-command" })).hash).not.toBe(
		scan(server({ API_TOKEN: "!second-command" })).hash,
	);
});

const sandboxed = (sandbox?: boolean) =>
	mcpItem({
		name: "fixture",
		source: "mcp.json",
		scope: "fixture-project",
		config: { command: "node", args: ["server.cjs"], ...(sandbox === undefined ? {} : { sandbox }) },
	});

it("asks again when a sandboxed server's sandbox is switched off", () => {
	const hash = approved(sandboxed(true));
	changed(sandboxed(false), hash);
	changed(sandboxed(undefined), hash);
});

it("keeps a server approved before the sandbox field existed", () => {
	const hash = approved(sandboxed(undefined));
	expect(scan(sandboxed(false)).hash).toBe(hash);
	const result = gate("mcp", [sandboxed(undefined)], { db, enforce: true });
	expect(result.allowed.has("mcp:fixture")).toBe(true);
	expect(JSON.stringify(sandboxed(undefined))).not.toContain("sandbox");
});
