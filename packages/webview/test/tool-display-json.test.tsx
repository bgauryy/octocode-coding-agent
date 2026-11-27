/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ToolDisplayView } from "../src/app/live/ToolDisplayView.tsx";

const show = (text: string) =>
	render(<ToolDisplayView display={{ title: "srv/tool", blocks: [{ type: "text", text }] }} />).container;

it("draws a JSON result indented and coloured, with numbers copied as sent", () => {
	const raw = '{"id":12345678901234567890,"name":"a","tags":["x",null],"empty":{}}';
	const view = show(raw);
	const pre = view.querySelector("pre.json-output");
	expect(pre?.textContent).toBe(
		'{\n  "id": 12345678901234567890,\n  "name": "a",\n  "tags": [\n    "x",\n    null\n  ],\n  "empty": {}\n}',
	);
	expect(pre?.querySelector(".hljs-attr")?.textContent).toBe('"id"');
	expect(pre?.querySelector(".hljs-number")?.textContent).toBe("12345678901234567890");
	expect(pre?.querySelectorAll(".hljs-string")).toHaveLength(2);
});

it("leaves other text and invalid JSON as it is", () => {
	for (const text of ["plain output", '{"broken": ', "[1, 2"]) {
		const pre = show(text).querySelector("pre");
		expect(pre?.textContent).toBe(text);
		expect(pre?.querySelector("span")).toBeNull();
	}
});

it("folds a long JSON document to its first lines", () => {
	const view = show(JSON.stringify({ rows: Array.from({ length: 30 }, (_, i) => i) }));
	expect(view.querySelector("pre")?.textContent?.split("\n")).toHaveLength(12);
	expect(view.querySelector("button")?.textContent).toMatch(/Show \d+ more lines/);
});
