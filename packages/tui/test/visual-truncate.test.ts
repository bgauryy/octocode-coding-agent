import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { truncateToVisualLines } from "../src/components/visual-truncate.ts";

/** The whole-text wrap the preview used to make: every line wrapped, then sliced. */
function wrapAllThenSlice(text: string, max: number, width: number, paddingX: number, keep: "start" | "end") {
	const all = new Text(text, paddingX, 0).render(width);
	if (all.length <= max) return { visualLines: all, skippedCount: 0 };
	return { visualLines: keep === "start" ? all.slice(0, max) : all.slice(-max), skippedCount: all.length - max };
}

/** Deterministic pseudo-random lines: styles opened on one line and closed lines later, wide text, tabs, blanks. */
function sample(seed: number, count: number): string {
	let state = seed;
	const next = () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
	const pieces = [
		"word",
		"\x1b[31m",
		"\x1b[39m",
		"\x1b[1m",
		"\x1b[22m",
		"\x1b[4m",
		"\x1b[24m",
		"日本語",
		"é",
		"\t",
		" ",
		"x".repeat(70),
	];
	const lines: string[] = [];
	for (let line = 0; line < count; line++) {
		let text = "";
		const parts = Math.floor(next() * 12);
		for (let part = 0; part < parts; part++) text += pieces[Math.floor(next() * pieces.length)];
		lines.push(text);
	}
	return lines.join(next() < 0.5 ? "\n" : "\r\n");
}

describe("truncateToVisualLines", () => {
	it("keeps the same lines and hidden count as wrapping the whole text", () => {
		for (let seed = 1; seed <= 150; seed++) {
			const text = sample(seed, 1 + (seed % 40));
			for (const keep of ["end", "start"] as const) {
				for (const [width, paddingX, max] of [
					[40, 0, 5],
					[23, 1, 3],
					[80, 0, 12],
				] as const) {
					assert.deepStrictEqual(
						truncateToVisualLines(text, max, width, paddingX, keep),
						wrapAllThenSlice(text, max, width, paddingX, keep),
						`seed ${seed} keep ${keep} width ${width}`,
					);
				}
			}
		}
	});

	it("wraps only the kept lines of a large result", () => {
		const big = Array.from({ length: 40_000 }, (_, index) => `\x1b[32mline ${index} ${"y".repeat(45)}\x1b[39m`).join(
			"\n",
		);
		// This process's CPU time, not wall time, and the best of three runs: other processes' load stretches the clock and,
		// through cache and frequency contention, a single run's CPU time too, not the work done here.
		let preview: ReturnType<typeof truncateToVisualLines> | undefined;
		let elapsed = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3; run++) {
			const start = process.cpuUsage();
			preview = truncateToVisualLines(big, 5, 80, 0, "end");
			const used = process.cpuUsage(start);
			elapsed = Math.min(elapsed, (used.user + used.system) / 1000);
		}
		assert.deepStrictEqual(preview, wrapAllThenSlice(big, 5, 80, 0, "end"));
		assert.strictEqual(preview?.skippedCount, 40_000 - 5);
		assert.ok(elapsed < 60, `${elapsed.toFixed(1)} ms of CPU for a 2 MB result`);
	});
});
