import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contextReads } from "../../src/octocode/files/reads.ts";
import { registerReadReceipts } from "../../src/octocode/files/read-receipts.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { snapshotLocalReads } from "../../src/octocode/shared/local-reads.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const search = "mcp__octocode__localSearch";
const fetch = "mcp__octocode__localFetch";
type Outcome = { ok: boolean; message?: string };
const CONTENT = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n") + "\n";

/** The file tool and the read receipts on separate fake hosts, as the real pipeline orders them: receipts first, then the guard. */
function setup() {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, "src.txt");
	fs.writeFileSync(file, CONTENT);
	// A file written before the search began, as a directory search requires.
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(file, past, past);
	const guard = new FileGuard();
	const receipts = fakeHost();
	const snapshots = registerReadReceipts(receipts.api);
	const files = fakeHost();
	registerFileTool(files.api, guard, fakePermission());
	const ctx = fakeCtx({ cwd, hasUI: false });
	let calls = 0;
	/** Run one read-tool call through receipts and the guard; returns the result message as the context would hold it. */
	const run = async (
		toolName: string,
		input: Record<string, unknown>,
		structuredContent: unknown,
		between?: () => void,
	) => {
		const toolCallId = `call-${++calls}`;
		// The file's ctime must precede the search by a clock tick, as a file that existed before it does.
		await new Promise((resolve) => setTimeout(resolve, 20));
		snapshots.set(toolCallId, await snapshotLocalReads(toolName, input, cwd));
		between?.();
		const event = {
			toolCallId,
			toolName,
			input,
			isError: false,
			content: [{ type: "text", text: "result" }],
			structuredContent,
		};
		const [receipt] = await receipts.emit("tool_result", event, { cwd });
		const details = (receipt as { details?: unknown } | undefined)?.details;
		await files.emit("tool_result", { ...event, details }, { cwd });
		return {
			role: "toolResult",
			toolCallId,
			toolName,
			content: event.content,
			isError: false,
			details,
			timestamp: Date.now() + 1000,
		};
	};
	/** One change through the file tool; a refusal throws its message, which this returns as the outcome. */
	const change = async (query: Record<string, unknown>): Promise<{ details: { outcomes: Outcome[] } }> => {
		try {
			return (await files.tools
				.get("file")
				.execute("change", { reason: "r", queries: [{ path: "src.txt", ...query }] }, undefined, undefined, ctx)) as {
				details: { outcomes: Outcome[] };
			};
		} catch (error) {
			return { details: { outcomes: [{ ok: false, message: (error as Error).message }] } };
		}
	};
	const edit = (oldText: string, newText: string) => change({ type: "edit", edits: [{ oldText, newText }] });
	const write = () => change({ type: "write", content: "new\n" });
	return { cwd, file, guard, run, edit, write };
}

/** A `localSearch` content result for one file: the rows as the server publishes them. */
const searchOutput = (file: string, matches: object[], extra: object = {}) => ({
	results: [{ index: 0, data: { matchCount: matches.length, files: [{ path: file, matches, ...extra }] } }],
});

describe("localSearch content rows count as partial reads", () => {
	it("lets an edit whose oldText is inside the shown lines succeed, context lines included", async () => {
		const { file, run, edit } = setup();
		await run(
			search,
			{ queries: [{ path: file, matchString: ["gamma"], contextLines: { before: 1, after: 1 } }] },
			searchOutput(file, [{ line: 3, value: "2\tbeta\n3\tgamma\n4\tdelta" }]),
		);
		const outcome = await edit("beta", "BETA");
		expect(outcome.details.outcomes[0]).toMatchObject({ ok: true });
		expect(fs.readFileSync(file, "utf8")).toBe(CONTENT.replace("beta", "BETA"));
	});

	it("counts a zero-context row, and resolves a workspace-relative path from a directory search", async () => {
		const { cwd, file, run, edit } = setup();
		await run(
			search,
			{ queries: [{ path: ".", matchString: ["zeta"] }] },
			searchOutput("src.txt", [{ line: 6, value: "zeta" }]),
		);
		expect((await edit("zeta", "ZETA")).details.outcomes[0]).toMatchObject({ ok: true });
		expect(fs.readFileSync(path.join(cwd, "src.txt"), "utf8")).toContain("ZETA");
		expect(file).toBe(path.join(cwd, "src.txt"));
	});

	it("refuses a write after only a search, naming the lines still unseen", async () => {
		const { file, run, write } = setup();
		await run(
			search,
			{ queries: [{ path: file, matchString: ["gamma"], contextLines: { before: 1, after: 1 } }] },
			searchOutput(file, [{ line: 3, value: "2\tbeta\n3\tgamma\n4\tdelta" }]),
		);
		const outcome = await write();
		expect(outcome.details.outcomes[0]).toMatchObject({ ok: false });
		expect(outcome.details.outcomes[0].message).toMatch(/seen lines 2–4 of its 6 lines/);
		expect(fs.readFileSync(file, "utf8")).toBe(CONTENT);
	});

	it("does not count clipped rows, shortened or altered lines, matchOnly values or a failed result", async () => {
		const { file, run, edit } = setup();
		const input = { queries: [{ path: file, matchString: ["gamma"] }] };
		await run(search, input, searchOutput(file, [{ line: 3, value: "gamma", clipped: true }]));
		await run(search, input, searchOutput(file, [{ line: 3, value: "gam…" }]));
		await run(search, input, searchOutput(file, [{ line: 3, column: 1, value: "gamma" }]));
		await run(search, input, searchOutput(file, [{ line: 3, value: "gamma" }], { truncated: true }));
		await run(search, input, {
			results: [{ index: 0, data: { error: "x", files: [{ path: file, matches: [{ line: 3, value: "gamma" }] }] } }],
		});
		expect((await edit("absent", "GAMMA")).details.outcomes[0].message).toMatch(/not read in this session/);
	});

	it("credits nothing when the file changed during the search", async () => {
		const { file, run, edit } = setup();
		await run(
			search,
			{ queries: [{ path: file, matchString: ["gamma"] }] },
			searchOutput(file, [{ line: 3, value: "gamma" }]),
			() => fs.writeFileSync(file, CONTENT.replace("gamma", "GAMMA")),
		);
		expect((await edit("absent", "g")).details.outcomes[0].message).toMatch(/not read in this session/);
	});

	it("counts a localFetch matchString view the same way", async () => {
		const { file, run, edit, write } = setup();
		await run(
			fetch,
			{ queries: [{ path: file, matchString: ["gamma"], contextLines: { before: 0, after: 1 } }] },
			{
				results: [
					{ index: 0, data: { content: "3\tgamma\n4\tdelta\n", totalLines: 6, pagination: { unit: "lines" } } },
				],
			},
		);
		expect((await edit("delta", "DELTA")).details.outcomes[0]).toMatchObject({ ok: true });
		expect((await write()).details.outcomes[0].message).toMatch(/seen lines 3–4 of its 6 lines/);
	});

	it("requires a reread after compaction drops the search result, and keeps the coverage while it stays in view", async () => {
		const { cwd, file, guard, run, edit } = setup();
		const message = await run(
			search,
			{ queries: [{ path: file, matchString: ["gamma"], contextLines: { before: 1, after: 1 } }] },
			searchOutput(file, [{ line: 3, value: "2\tbeta\n3\tgamma\n4\tdelta" }]),
		);
		const session = (messages: unknown[]) => ({
			cwd,
			sessionManager: {
				getBranch: () => [],
				buildSessionProjection: () => ({
					entries: messages.map((m, i) => ({ sourceEntry: { id: `e${i}` }, messages: [m] })),
					messages,
				}),
			},
		});
		guard.restore(contextReads(session([message]) as never));
		expect(guard.check(file, "edit", "src.txt")).toBeUndefined();
		expect(guard.check(file, "write", "src.txt")).toMatch(/seen lines 2–4 of its 6 lines/);
		guard.restore(contextReads(session([]) as never));
		expect((await edit("beta", "BETA")).details.outcomes[0].message).toMatch(/read .* again/i);
	});
});
