import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repeatReadNotes } from "../../src/octocode/files/repeat-reads.ts";
import { CLEARED_RESULTS_TYPE } from "../../src/octocode/files/reads.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A second whole read of an unchanged file, its first still in context, gets a note instead of the text once. */

const CONTENT = "export const value = 1;\n".repeat(200);
const NOTE = /^\[Not shown again: src\/a\.ts is unchanged since your earlier whole read/;

/** A session whose context grows with each result the handler lets through (or the note it put in its place). */
function session() {
	const cwd = fs.realpathSync(tmp("repeat-"));
	fs.mkdirSync(path.join(cwd, "src"));
	const file = path.join(cwd, "src", "a.ts");
	fs.writeFileSync(file, CONTENT);
	const fake = fakeHost();
	const notes = repeatReadNotes();
	fake.api.bus.on("tool_result", async (event, context) => notes(event, context));
	let messages: unknown[] = [];
	const branch: unknown[] = [];
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx, {
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => branch,
			buildSessionProjection: () => ({
				entries: messages.map((message, index) => ({ sourceEntry: { id: `m${index}` }, messages: [message] })),
				messages,
			}),
		},
	});
	let counter = 0;
	/** Runs one call through the handler and appends what the model then sees; returns its id and what it saw. */
	const call = async (
		toolName: string,
		input: Record<string, unknown>,
		details: Record<string, unknown> = {},
		extra: Record<string, unknown> = {},
	) => {
		const id = `call${++counter}`;
		const content = [{ type: "text", text: CONTENT }];
		const changed = (await fake.fire(
			"tool_result",
			{ type: "tool_result", toolName, toolCallId: id, input, content, isError: false, details, ...extra },
			ctx,
		)) as { content?: Array<{ text: string }>; details?: Record<string, unknown> } | undefined;
		messages.push(
			{ role: "assistant", content: [{ type: "toolCall", id, name: toolName, arguments: input }] },
			{
				role: "toolResult",
				toolCallId: id,
				toolName,
				content: changed?.content ?? content,
				details: changed?.details ?? details,
				isError: false,
			},
		);
		return { id, text: (changed?.content ?? content)[0].text, details: changed?.details };
	};
	const bash = (command: string, details?: Record<string, unknown>) => call("bash", { command }, details);
	return {
		cwd,
		file,
		bash,
		call,
		compact: () => (messages = []),
		clear: (id: string) =>
			branch.push({
				type: "custom",
				id: `c${id}`,
				customType: CLEARED_RESULTS_TYPE,
				data: { results: [{ id, saved: "/x" }] },
			}),
	};
}

describe("a repeated whole read of an unchanged file", () => {
	it("answers the second `cat` with a note pointing at the first, and the third with the text", async () => {
		const s = session();
		const first = await s.bash("cat src/a.ts");
		expect(first.text).toBe(CONTENT);
		const second = await s.bash("cat src/a.ts");
		expect(second.text).toMatch(NOTE);
		expect(second.details).toMatchObject({ unchangedOf: first.id });
		// The model insists: the text comes back.
		expect((await s.bash("cat src/a.ts")).text).toBe(CONTENT);
	});

	it("gives the text when the file changed since (size or modification time)", async () => {
		const s = session();
		await s.bash("cat src/a.ts");
		fs.appendFileSync(s.file, "export const more = 2;\n");
		expect((await s.bash("cat src/a.ts")).text).toBe(CONTENT);
	});

	it("gives the text when the earlier result was cleared or compacted away", async () => {
		const s = session();
		const first = await s.bash("cat src/a.ts");
		s.clear(first.id);
		expect((await s.bash("cat src/a.ts")).text).toBe(CONTENT);
		await s.bash("cat src/a.ts");
		s.compact();
		expect((await s.bash("cat src/a.ts")).text).toBe(CONTENT);
	});

	it("notes only a command whose whole output is that one file; any whole print counts as the earlier read", async () => {
		const s = session();
		fs.writeFileSync(path.join(s.cwd, "src", "b.ts"), "b\n");
		await s.bash("cat src/a.ts src/b.ts");
		expect((await s.bash("cat src/a.ts src/b.ts")).text).toBe(CONTENT);
		const echoed = await s.bash("echo start && cat src/a.ts");
		expect(echoed.text).toBe(CONTENT);
		const alone = await s.bash(`cd ${s.cwd} && cat src/a.ts`);
		expect(alone.text).toMatch(NOTE);
		expect(alone.details).toMatchObject({ unchangedOf: echoed.id });
	});

	it("never notes a range, a cut output, or a nested call", async () => {
		const s = session();
		await s.bash("sed -n '1,40p' src/a.ts");
		expect((await s.bash("sed -n '1,40p' src/a.ts")).text).toBe(CONTENT);
		await s.bash("cat src/a.ts", { truncation: { truncated: true } });
		const whole = await s.bash("cat src/a.ts");
		expect(whole.text).toBe(CONTENT);
		const nested = await s.call("bash", { command: "cat src/a.ts" }, {}, { parentToolCallId: whole.id });
		expect(nested.text).toBe(CONTENT);
		expect((await s.bash("cat src/a.ts")).text).toMatch(NOTE);
	});

	it("compares a reader's credited reads by SHA-256, and leaves a call with the same arguments to the read dedupe", async () => {
		const s = session();
		const read = { file: s.file, sha256: "a".repeat(64), size: CONTENT.length, whole: true };
		const reader = (input: Record<string, unknown>) => s.call("localFetch", input, { localReads: [read] });
		await reader({ queries: [{ path: "src/a.ts" }] });
		const same = await reader({ queries: [{ path: "src/a.ts" }] });
		expect(same.text).toBe(CONTENT);
		const other = await reader({ queries: [{ path: "src/a.ts", responseChars: 90000 }] });
		expect(other.text).toMatch(NOTE);
		expect(other.details).toMatchObject({ unchangedOf: same.id, localReads: [read] });
		// A bash print of the same file is compared by its own measure, so it never stands for the reader's read.
		expect((await s.bash("cat src/a.ts")).text).toBe(CONTENT);
	});
});
