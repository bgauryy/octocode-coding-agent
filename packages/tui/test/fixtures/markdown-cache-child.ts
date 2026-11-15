import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Markdown } from "../../src/components/markdown.ts";
import { defaultMarkdownTheme } from "../test-themes.ts";
import { RenderRuntimeMetrics } from "../../src/tui/runtime-metrics.ts";

async function collect(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await tick();
		globalThis.gc!();
	}
	await tick();
}

let highlights = 0;
const metrics = new RenderRuntimeMetrics();
metrics.setEnabled(true);
const theme = {
	...defaultMarkdownTheme,
	highlightCode: (code: string) => {
		highlights++;
		return code.split("\n");
	},
};
const source = "```ts\nconst answer = 42;\n```\n\n# Stable heading\n\nStreaming tail";
const markdown = new Markdown(source, 0, 0, theme, undefined, { streaming: true });
markdown.render(80);
assert.equal(highlights, 1);
await collect();
markdown.setText(`${source} appended`);
assert.match(markdown.render(80).join("\n"), /appended/);
assert.equal(highlights, 1, "a full GC must not re-highlight stable blocks of an active stream");

markdown.setStreaming(false);
await collect();
markdown.invalidate();
markdown.render(80);
assert.equal(highlights, 2, "completed content must allow its parse cache to be collected");

markdown.setStreaming(true);
markdown.setText(`${source}\n\n${"x ".repeat(70_000)}`);
markdown.render(80);
const beforeLarge = highlights;
await collect();
markdown.setText(`${source}\n\n${"x ".repeat(70_000)} tail`);
markdown.render(80);
assert.ok(highlights > beforeLarge, "oversized streams must not pin their token tree");

markdown.setText(source);
markdown.render(80);
markdown.dispose();
const beforeDisposed = highlights;
await collect();
markdown.invalidate();
markdown.render(80);
assert.ok(highlights > beforeDisposed, "disposal releases an active parse cache");
const stats = metrics.snapshot()!;
assert.ok(stats.gcCount > 0 && stats.gcDurationMs > 0, "runtime counters observe actual collections");
metrics.setEnabled(false);
