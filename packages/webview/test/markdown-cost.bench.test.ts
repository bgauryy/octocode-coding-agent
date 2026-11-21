/** @vitest-environment jsdom */
// Cost of one Markdown render by message size (B91). jsdom stands in for the browser's DOM, so the sanitize and walk
// numbers are an upper bound; marked and highlight.js are pure and measured as they run.
//   OCTOCODE_BENCH=1 yarn vitest run --config packages/webview/vitest.config.ts test/markdown-cost.bench.test.ts
import os from "node:os";
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/app/live/Markdown.tsx";
import { sanitizeMarkdown } from "../src/markdown.ts";

const block = (i: number) =>
	[
		`## Section ${i}`,
		`Paragraph with **bold**, _emphasis_, \`inline code\` and a [link](https://example.com/${i}). ${"Lorem ipsum dolor sit amet. ".repeat(6)}`,
		`- item one ${i}\n- item two with \`code\`\n- item three`,
		"```ts\nexport function add(a: number, b: number): number {\n\tconst total = a + b;\n\treturn total > 100 ? 100 : total;\n}\n```",
		"| col a | col b |\n| --- | --- |\n| 1 | two |\n| 3 | four |",
		"",
	].join("\n\n");
const message = (kb: number) => {
	let text = "";
	for (let i = 0; text.length < kb * 1024; i++) text += block(i);
	return text;
};
const cpuMs = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};
/** CPU ms per call, best of `runs` after one warmup. */
function cost(run: () => unknown, runs = 5): number {
	run();
	let best = Infinity;
	for (let i = 0; i < runs; i++) {
		const c0 = cpuMs();
		run();
		best = Math.min(best, cpuMs() - c0);
	}
	return +best.toFixed(1);
}

describe.skipIf(!process.env.OCTOCODE_BENCH)("markdown cost", () => {
	it("reports parse, sanitize and render CPU by size", () => {
		const rows = [5, 20, 100].map((kb) => {
			const text = message(kb);
			const parse = cost(() => marked.parse(text, { async: false, gfm: true }));
			const sanitize = cost(() => sanitizeMarkdown(text));
			const render = cost(() => renderMarkdown(text), 3);
			return { kb, chars: text.length, markedMs: parse, parseSanitizeHighlightMs: sanitize, renderReactMs: render };
		});
		// A streamed message re-renders its whole text per update: cumulative CPU for 200-char deltas to each size.
		const stream = [5, 20].map((kb) => {
			const text = message(kb);
			const c0 = cpuMs();
			let updates = 0;
			for (let end = 200; end <= text.length; end += 200, updates++) renderMarkdown(text.slice(0, end));
			return { kb, updates, cumulativeCpuMs: +(cpuMs() - c0).toFixed(0) };
		});
		process.stdout.write(`${JSON.stringify({ rows, stream, load1: os.loadavg()[0].toFixed(1) }, null, 1)}\n`);
		expect(rows.length).toBe(3);
	}, 600_000);
});
