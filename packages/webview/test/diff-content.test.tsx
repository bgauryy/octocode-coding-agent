/** @vitest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { DiffView } from "../src/app/live/DiffView.tsx";

it("counts lines beginning with double signs as changes inside unified diff hunks", () => {
	render(
		<DiffView
			diffs={[
				{
					path: "counter.ts",
					type: "edit",
					diff: "--- a/counter.ts\n+++ b/counter.ts\n@@ -1,2 +1,2 @@\n---counter;\n+++counter;\n context",
				},
			]}
		/>,
	);
	const file = screen.getByRole("figure", { name: "counter.ts: 1 added, 1 removed" });
	expect(within(file).getByText("--- a/counter.ts")).toHaveClass("diff-meta");
	expect(within(file).getByText("+++ b/counter.ts")).toHaveClass("diff-meta");
	expect(within(file).getByText("---counter;")).toHaveClass("diff-del");
	expect(within(file).getByText("+++counter;")).toHaveClass("diff-add");
});

it("keeps multiple sequential edits to the same file visible", () => {
	render(
		<DiffView
			diffs={[
				{ path: "a.ts", type: "edit", diff: "@@ -1 +1 @@\n-first\n+second" },
				{ path: "a.ts", type: "edit", diff: "@@ -1 +1 @@\n-second\n+third" },
			]}
		/>,
	);
	expect(screen.getAllByRole("figure")).toHaveLength(2);
	expect(screen.getByText("+second")).toBeInTheDocument();
	expect(screen.getByText("+third")).toBeInTheDocument();
});
