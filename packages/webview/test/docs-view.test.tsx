/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DocSummary } from "@octocodeai/octocode-contracts/docs";
import { DocsView } from "../src/app/live/DocsView.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import { diagramLabel, filterDocs, groupDocs, splitBacklogRefs } from "../src/app/model/docs.ts";
import { snapshotItem } from "./helpers.ts";

const { docs, docFile, mermaidScript, mermaid, loadMermaid, live } = vi.hoisted(() => {
	const docs = vi.fn();
	const docFile = vi.fn();
	const mermaidScript = vi.fn();
	const mermaid = { initialize: vi.fn(), render: vi.fn() };
	const loadMermaid = vi.fn();
	return { docs, docFile, mermaidScript, mermaid, loadMermaid, live: { api: { docs, docFile, mermaidScript } } };
});
vi.mock("../src/app/live/session.tsx", () => ({ useLive: () => live }));
vi.mock("../src/app/live/mermaid-loader.ts", () => ({ loadMermaid }));

const index = indexBacklog({
	repo: "r",
	generatedAt: 0,
	states: [],
	idleMs: 1,
	items: [snapshotItem("B12")],
});

const rfc: DocSummary = {
	path: "octocode-rfc-generator/voice/RFC.md",
	kind: "rfc",
	topic: "octocode-rfc-generator",
	title: "Voice engine",
	updated: "2026-10-25T12:00:00.000Z",
	bytes: 900,
	status: "Proposed",
};
const audit: DocSummary = {
	path: "audit-2026-10-27/findings.md",
	kind: "audit",
	topic: "audit-2026-10-27",
	title: "Audit findings",
	updated: "2026-10-27T12:00:00.000Z",
	bytes: 400,
};
const scratch: DocSummary = {
	path: "tmp/notes.md",
	kind: "report",
	topic: "tmp",
	title: "Scratch notes",
	updated: "2026-10-28T12:00:00.000Z",
	bytes: 10,
};

function Harness({ start = {} }: { start?: Record<string, string> }) {
	const [params, setParams] = useState(start);
	return <DocsView index={index} params={params} setParams={setParams} />;
}

beforeEach(() => {
	for (const fn of [docs, docFile, mermaidScript, mermaid.initialize, mermaid.render, loadMermaid]) fn.mockReset();
	docs.mockImplementation(async (includeTmp: boolean) => ({
		docs: includeTmp ? [scratch, audit, rfc] : [audit, rfc],
		truncated: false,
		tmp: includeTmp,
	}));
	loadMermaid.mockResolvedValue(mermaid);
	document.documentElement.style.setProperty("--accent", "#6d28d9");
});

it("groups documents by kind and folder, filters them, and asks for tmp/ only on request", async () => {
	render(<Harness />);
	expect(await screen.findByText("Voice engine")).toBeTruthy();
	expect(screen.getByRole("region", { name: "RFCs" })).toBeTruthy();
	expect(screen.getByRole("region", { name: "Audits" })).toBeTruthy();
	expect(docs).toHaveBeenLastCalledWith(false, expect.anything());
	expect(screen.queryByText("Scratch notes")).toBeNull();
	await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "audit");
	expect(screen.queryByText("Voice engine")).toBeNull();
	expect(screen.getByText("Audit findings")).toBeTruthy();
	await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "");
	await userEvent.type(screen.getByRole("searchbox"), "voice");
	expect(screen.queryByText("Audit findings")).toBeNull();
	await userEvent.clear(screen.getByRole("searchbox"));
	await userEvent.click(screen.getByRole("checkbox", { name: /tmp/ }));
	expect(await screen.findByText("Scratch notes")).toBeTruthy();
	expect(docs).toHaveBeenLastCalledWith(true, expect.anything());
});

it("renders a diagram with strict security and the page theme, and links backlog ids the board holds", async () => {
	docFile.mockResolvedValue({
		path: rfc.path,
		markdown: "# Voice\n\nSee B12 and B99.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n",
	});
	mermaid.render.mockResolvedValue({
		svg: '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><a href="https://evil.example"><text>A</text></a></svg>',
	});
	render(<Harness start={{ path: rfc.path }} />);
	await waitFor(() => expect(document.querySelector(".diagram-canvas svg")).toBeTruthy());
	const config = mermaid.initialize.mock.calls[0][0];
	expect(config).toMatchObject({ securityLevel: "strict", startOnLoad: false, theme: "base" });
	expect(config.themeVariables.primaryBorderColor).toBe("#6d28d9");
	expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "flowchart TD\n  A --> B\n");
	const svg = document.querySelector(".diagram-canvas svg")!;
	expect(svg.getAttribute("onload")).toBeNull();
	expect(svg.querySelector("script")).toBeNull();
	expect(svg.querySelector("a")).toBeNull();
	expect(svg.textContent).toContain("A");
	expect(screen.getByText("Flowchart")).toBeTruthy();
	expect(screen.getByRole("link", { name: "B12" }).getAttribute("href")).toBe("#B12");
	expect(screen.queryByRole("link", { name: "B99" })).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "Show source" }));
	expect(document.querySelector(".diagram-source")!.hasAttribute("hidden")).toBe(false);
});

it("shows the diagram source with the parse error when Mermaid cannot draw it", async () => {
	docFile.mockResolvedValue({ path: rfc.path, markdown: "```mermaid\ngraph TD\n  A -->\n```\n" });
	mermaid.render.mockRejectedValue(new Error("Parse error on line 2\nExpecting NODE_STRING"));
	render(<Harness start={{ path: rfc.path }} />);
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("Parse error on line 2");
	expect(alert.textContent).not.toContain("Expecting");
	const source = document.querySelector(".diagram-source")!;
	expect(source.hasAttribute("hidden")).toBe(false);
	expect(source.textContent).toContain("A -->");
});

it("shows the source when the renderer cannot be loaded, and never loads it for a document without diagrams", async () => {
	docFile.mockResolvedValue({ path: audit.path, markdown: "# Plain\n\nNo diagrams.\n" });
	const plain = render(<Harness start={{ path: audit.path }} />);
	expect(await screen.findByText("No diagrams.")).toBeTruthy();
	expect(loadMermaid).not.toHaveBeenCalled();
	plain.unmount();
	docFile.mockResolvedValue({ path: rfc.path, markdown: "```mermaid\ngraph TD\n  A --> B\n```\n" });
	loadMermaid.mockRejectedValue(new Error("Could not load the diagram renderer"));
	render(<Harness start={{ path: rfc.path }} />);
	expect((await screen.findByRole("alert")).textContent).toContain("Could not load the diagram renderer");
	expect(document.querySelector(".diagram-source")!.textContent).toContain("graph TD");
});

it("filters, groups, splits ids and labels diagrams", () => {
	expect(filterDocs([rfc, audit], "", "proposed")).toEqual([rfc]);
	expect(groupDocs([audit, rfc]).map((group) => group.kind)).toEqual(["rfc", "audit"]);
	expect(splitBacklogRefs("B1 and B2, not XB3", (ref) => ref !== "B2")).toEqual([{ ref: "B1" }, " and B2, not XB3"]);
	expect(diagramLabel("%% note\nsequenceDiagram\n A->>B: hi")).toBe("Sequence");
	expect(diagramLabel("---\ntitle: x\n---\nflowchart LR\n A-->B")).toBe("Flowchart");
	expect(diagramLabel("mystery-beta\n")).toBe("mystery");
});
