import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchPaths, normalizeRepoPath } from "@octocodeai/octocode-contracts/backlogs";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const READY = { goal: "Result can be checked", why: "Users need it" };

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-path-search-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const tool = fake.tools.get("backlog");
	const ctx = fakeCtx({ cwd });
	return {
		cwd,
		backlog: async (params: Record<string, unknown>) => {
			const args = tool.validationParameters ? { reason: "test", ...params } : params;
			const valid = validateToolArguments(tool, {
				type: "toolCall",
				id: "id",
				name: "backlog",
				arguments: args,
			} as never);
			const result = (await tool.execute("id", valid, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			};
			return result.content[0].text;
		},
	};
}

const refs = (text: string) => [...text.matchAll(/^(B\d+) /gm)].map((m) => m[1]);
const line = (text: string, ref: string) => text.split("\n").find((l) => l.startsWith(`${ref} `)) ?? "";

describe("backlog list by path", () => {
	async function seed() {
		const t = setup();
		const add = (title: string, extra: Record<string, unknown>) =>
			t.backlog({ op: "add", title, ...READY, state: "todo", ...extra });
		await add("file item", { paths: ["packages/db/src/queries/a.ts"] }); // B1
		await add("shallow folder", { paths: ["packages/db/"] }); // B2
		await add("deep folder", { paths: ["packages/db/src/queries"] }); // B3
		await add("sibling lookalike", { paths: ["packages/db/src/queries/ab.ts", "packages/dbx"] }); // B4
		await add("evidence only", { paths: ["docs"], evidence: ["packages/db/src/queries/a.ts:42 — the filter"] }); // B5
		await add("link only", { paths: ["other"], evidence: ["packages/db/src/queries/a.ts"] }); // B6
		await add("unrelated", { paths: ["packages/tui"] }); // B7
		return t;
	}

	it("finds exact file, containing folders and mentions, ranked with reasons", async () => {
		const t = await seed();
		const out = await t.backlog({ op: "list", paths: ["packages/db/src/queries/a.ts"] });
		expect(refs(out)).toEqual(["B1", "B3", "B2", "B6", "B5"]);
		expect(line(out, "B1")).toContain("matched: exact path");
		expect(line(out, "B3")).toContain("matched: folder packages/db/src/queries in Where");
		expect(line(out, "B5")).toContain("matched: evidence packages/db/src/queries/a.ts:42");
		expect(line(out, "B6")).toContain("link packages/db/src/queries/a.ts");
	});

	it("finds items under a folder query and respects path boundaries", async () => {
		const t = await seed();
		const under = await t.backlog({ op: "list", paths: ["packages/db/src/queries"] });
		expect(refs(under)).toEqual(["B3", "B2", "B4", "B1", "B6", "B5"]);
		expect(line(under, "B1")).toContain("is under packages/db/src/queries");
		const lookalike = await t.backlog({ op: "list", paths: ["packages/db/src/queries/a"] });
		expect(refs(lookalike)).toEqual(["B3", "B2"]);
		expect(refs(await t.backlog({ op: "list", paths: ["packages/dbx"] }))).toEqual(["B4"]);
	});

	it("normalizes ./, absolute, trailing slash and Windows separators", async () => {
		const t = await seed();
		// Equal matches keep board order: the most recently updated first.
		const want = ["B1", "B3", "B2", "B6", "B5"];
		for (const input of [
			"./packages/db/src/queries/a.ts",
			path.join(t.cwd, "packages/db/src/queries/a.ts"),
			"packages\\db\\src\\queries\\a.ts",
			"packages/db/src/queries/a.ts:12",
		])
			expect(refs(await t.backlog({ op: "list", paths: [input] })), input).toEqual(want);
		expect(refs(await t.backlog({ op: "list", paths: ["packages/tui/"] }))).toEqual(["B7"]);
	});

	it("hides closed items unless asked and combines with type and state", async () => {
		const t = setup();
		await t.backlog({ op: "add", title: "open", ...READY, state: "todo", paths: ["src/x.ts"] });
		await t.backlog({ op: "add", title: "bug", type: "bug", ...READY, state: "todo", paths: ["src"] });
		await t.backlog({ op: "add", title: "gone", ...READY, state: "todo", paths: ["src/x.ts"] });
		await t.backlog({ op: "update", id: "B3", close: { kind: "obsolete", text: "no longer needed" } });
		expect(refs(await t.backlog({ op: "list", paths: ["src/x.ts"] }))).toEqual(["B1", "B2"]);
		expect(refs(await t.backlog({ op: "list", paths: ["src/x.ts"], states: ["closed"] }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", paths: ["src/x.ts"], type: "bug" }))).toEqual(["B2"]);
	});
});

describe("path matcher", () => {
	it("normalizes inputs", () => {
		expect(normalizeRepoPath("./a\\b/")).toBe("a/b");
		expect(normalizeRepoPath("a/b.ts:3-9")).toBe("a/b.ts");
		expect(normalizeRepoPath(".")).toBe("");
	});

	it("matches on whole segments and ranks the deepest folder", () => {
		const item = (paths: string[]) => ({ paths, evidence: [] });
		expect(matchPaths(item(["src/ab"]), ["src/a"])).toBeUndefined();
		expect(matchPaths(item(["src"]), ["src/a/b.ts"])?.depth).toBe(1);
		expect(matchPaths(item(["src/a"]), ["src/a/b.ts"])?.depth).toBe(2);
		expect(matchPaths({ paths: [], evidence: ["README is here"] }, ["README"])).toBeUndefined();
	});
});
