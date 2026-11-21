import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { replayLine, replayMarkdown } from "./replay/report.ts";
import { replay, type ReplayResult } from "./replay/run.ts";

/**
 * Opt-in heavy replay of any local session file: `OCTOCODE_TEST_REPLAY_SESSION=<file.jsonl>`. Skipped without it. A copy of the file is replayed in temporary
 * folders; the file itself is only read. Real sessions hold private content: never commit one, nor its report.
 *
 * Options, all `OCTOCODE_TEST_*` because the suite clears every other `OCTOCODE_*` variable before a test starts:
 * `OCTOCODE_TEST_REPLAY_WINDOW` (tokens, default 200000), `OCTOCODE_TEST_REPLAY_OUT` (a Markdown report; the JSON result
 * beside it), `OCTOCODE_TEST_REPLAY_PROFILE` (a folder for a CPU profile), `OCTOCODE_TEST_REPLAY_HEAP=1` (and a heap
 * profile), `OCTOCODE_TEST_REPLAY_KEEP` (a folder to copy the replayed session file to).
 */

const source = process.env.OCTOCODE_TEST_REPLAY_SESSION;
const env = (name: string) => process.env[`OCTOCODE_TEST_REPLAY_${name}`] || undefined;

describe.skipIf(!source)("a local session replayed (opt-in)", () => {
	let result: ReplayResult;

	beforeAll(async () => {
		const file = path.resolve(source!);
		result = await replay({
			source: file,
			contextWindow: Number(env("WINDOW") ?? 200_000),
			name: path.basename(file, ".jsonl"),
			profileDir: env("PROFILE"),
			heapProfile: env("HEAP") === "1",
			keepDir: env("KEEP"),
		});
		const out = env("OUT");
		if (out) {
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, replayMarkdown(result));
			fs.writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify(result, null, "\t"));
		}
		process.stderr.write(`${replayLine(result)}\n`);
	}, 3_600_000);

	// A real session holds what a replay cannot reproduce (messages delivered inside a run, runs cut by a steer), so only
	// what must hold for any recording is asserted; the report holds the rest.
	it("replays every turn without a prompt error", () => {
		expect(result.turnsDone).toBe(result.recording.turns);
		expect(result.promptErrors).toEqual([]);
	});

	it("reopens to the same projection, with the database mirror level with the file", () => {
		expect(result.projectionStable).toBe(true);
		expect(result.mirror.byteSize).toBe(result.file.bytes);
		expect(result.persistenceFailures).toEqual([]);
	});

	it("keeps every user message recoverable after every compaction", () => {
		expect(result.recovery.flatMap((row) => row.lost)).toEqual([]);
	});
});
