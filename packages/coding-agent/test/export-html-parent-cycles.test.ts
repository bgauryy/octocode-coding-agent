import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

// The exported HTML walks parent links in the browser. A damaged session file can name an entry as its own
// parent or close a loop; those walks must end instead of hanging the page. The page scripts run here in a
// VM context whose timeout turns a hang into a failure.
const scriptDir = join(import.meta.dirname, "../src/core/export-html/script");
const source = ["tree-data.js", "filter.js"].map((name) => readFileSync(join(scriptDir, name), "utf8")).join("\n");

function entry(id: string, parentId: string | null, type = "message") {
	const message = { role: "user", content: id, timestamp: 1 };
	return type === "message"
		? { type, id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message }
		: { type, id, parentId, timestamp: "2026-01-01T00:00:00.000Z", provider: "p", modelId: "m" };
}

function page(entries: ReturnType<typeof entry>[]) {
	const context = createContext({ entries, byId: new Map(entries.map((e) => [e.id, e])), labelMap: new Map() });
	runInContext(source, context);
	return (expression: string, values: Record<string, unknown> = {}) => {
		Object.assign(context, values);
		return runInContext(expression, context, { timeout: 2000 });
	};
}

describe("exported HTML with looping parent links", () => {
	it("builds the path and active path of an entry inside a two-entry loop", () => {
		const run = page([entry("a", "b"), entry("b", "a"), entry("c", "b")]);
		expect(run("getPath('c').map((e) => e.id)")).toEqual(["a", "b", "c"]);
		expect([...run("buildActivePathIds('c')")]).toEqual(["a", "b", "c"]);
	});

	it("lays out a filtered tree whose hidden entry is its own parent", () => {
		const hidden = entry("x", "x", "model_change");
		const child = entry("y", "x");
		const all = [hidden, child].map((e) => ({ node: { entry: e } }));
		const run = page([hidden, child]);
		run("recalculateVisualStructure(filtered, all)", { filtered: [all[1]], all });
		expect(all[1]).toMatchObject({ indent: 0, isLast: true });
	});
});
