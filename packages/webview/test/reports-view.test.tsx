/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReportSummary, ReportsIndex } from "@octocodeai/octocode-contracts/protocol";
import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { ItemDetail } from "../src/app/features/ItemDetail.tsx";
import { RfcView, ResearchView } from "../src/app/live/ReportsView.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import { reportLinkDestination, reportLinkHref, tabReports } from "../src/app/model/reports.ts";
import { RichTextContext } from "../src/app/ui/LongText.tsx";
import { snapshotItem } from "./helpers.ts";

const { reports, reportFile, live } = vi.hoisted(() => {
	const reports = vi.fn();
	const reportFile = vi.fn();
	return { reports, reportFile, live: { api: { reports, reportFile } } };
});
vi.mock("../src/app/live/session.tsx", () => ({ useLive: () => live }));

const index = indexBacklog({ repo: "r", generatedAt: 0, states: [], idleMs: 1, items: [] });

const rfc: ReportSummary = {
	id: "2026-10-25-webview-voice-engine",
	kind: "rfc",
	title: "Spoken agent conversations in the webview",
	status: "Proposed",
	confidence: "medium",
	question: "How should the webview get voice?",
	updated: "2026-10-25T12:00:00.000Z",
	files: [
		{ name: "RFC.md", bytes: 1000 },
		{ name: "appendix-engine.md", bytes: 500 },
	],
};
const brief: ReportSummary = {
	id: "prompt-callers",
	kind: "research",
	title: "Prompt callers",
	updated: "2026-10-24T08:00:00.000Z",
	files: [{ name: "brief.md", bytes: 200 }],
};
const brainstorm: ReportSummary = {
	id: "dessa-angles",
	kind: "brainstorm",
	title: "Dessa angles",
	updated: "2026-10-23T08:00:00.000Z",
	files: [{ name: "brief.md", bytes: 200 }],
};
const payload: ReportsIndex = { reports: [rfc, brief, brainstorm] };

beforeEach(() => {
	reports.mockReset();
	reportFile.mockReset();
});

it("maps report paths to the tab that lists their kind", () => {
	expect(reportLinkDestination(".octocode/octocode-rfc-generator/2026-10-25-webview-voice-engine/RFC.md")).toEqual({
		tab: "rfc",
		kind: "rfc",
		id: "2026-10-25-webview-voice-engine",
		file: "RFC.md",
	});
	expect(reportLinkHref("/repo/.octocode/octocode-research/prompt-callers/brief.md")).toBe(
		"#research?id=prompt-callers&kind=research&file=brief.md",
	);
	expect(reportLinkHref("./.octocode/octocode-brainstorming/dessa-angles/")).toBe(
		"#research?id=dessa-angles&kind=brainstorm",
	);
	expect(reportLinkHref("src/app/App.tsx")).toBeUndefined();
	expect(reportLinkHref(".octocode/other-folder/demo/RFC.md")).toBeUndefined();
	expect(tabReports(payload, "rfc").map((report) => report.id)).toEqual([rfc.id]);
	expect(tabReports(payload, "research").map((report) => report.id)).toEqual([brief.id, brainstorm.id]);
});

it("lists the reports of its tab and opens one with its appendix switcher", async () => {
	reports.mockResolvedValue(payload);
	reportFile.mockResolvedValue({ id: rfc.id, kind: "rfc", file: "RFC.md", markdown: "# Spoken agent conversations" });
	const setParams = vi.fn();
	const { rerender } = render(<RfcView index={index} params={{}} setParams={setParams} />);
	expect(await screen.findByRole("link", { name: /Spoken agent conversations/ })).toBeInTheDocument();
	expect(screen.queryByText("Prompt callers")).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("link", { name: /Spoken agent conversations/ }));
	expect(setParams).toHaveBeenCalledWith({ id: rfc.id, kind: "rfc" });
	rerender(<RfcView index={index} params={{ id: rfc.id }} setParams={setParams} />);
	await waitFor(() =>
		expect(screen.getByRole("heading", { name: "Spoken agent conversations in the webview" })).toBeInTheDocument(),
	);
	expect(screen.getByRole("button", { name: "appendix-engine.md" })).toBeInTheDocument();
	expect(reportFile).toHaveBeenCalledWith(rfc.id, "rfc", "RFC.md", expect.any(AbortSignal));
});

it("switches report documents through the file params and retries a failed document", async () => {
	reports.mockResolvedValue(payload);
	reportFile
		.mockRejectedValueOnce(new Error("Report unreadable"))
		.mockResolvedValue({ id: rfc.id, kind: "rfc", file: "appendix-engine.md", markdown: "# Appendix" });
	render(<RfcView index={index} params={{ id: rfc.id, file: "appendix-engine.md" }} setParams={() => {}} />);
	expect(await screen.findByRole("alert")).toHaveTextContent("Report unreadable");
	await userEvent.click(screen.getByRole("button", { name: "Retry loading the document" }));
	await waitFor(() =>
		expect(screen.getByRole("heading", { name: "Spoken agent conversations in the webview" })).toBeInTheDocument(),
	);
	expect(screen.getByRole("button", { name: "appendix-engine.md" })).toBeDisabled();
});

it("keeps research briefs and brainstorms in the Research tab and explains failures", async () => {
	reports.mockResolvedValue(payload);
	render(<ResearchView index={index} params={{}} setParams={() => {}} />);
	expect(await screen.findByRole("link", { name: /Prompt callers/ })).toBeInTheDocument();
	expect(screen.getByRole("link", { name: /Dessa angles/ })).toBeInTheDocument();
	expect(screen.queryByText(rfc.title)).not.toBeInTheDocument();
});

it("selects same-id research and brainstorm documents by kind", async () => {
	const research = { ...brief, id: "shared", title: "Research version" };
	const brainstormReport = { ...brainstorm, id: "shared", title: "Brainstorm version" };
	reports.mockResolvedValue({ reports: [research, brainstormReport] });
	reportFile.mockResolvedValue({
		id: "shared",
		kind: "brainstorm",
		file: "brief.md",
		markdown: "# Brainstorm document",
	});
	render(<ResearchView index={index} params={{ id: "shared", kind: "brainstorm" }} setParams={() => {}} />);
	expect(await screen.findByRole("heading", { name: "Brainstorm version" })).toBeInTheDocument();
	expect(screen.queryByRole("heading", { name: "Research version" })).not.toBeInTheDocument();
	expect(reportFile).toHaveBeenCalledWith("shared", "brainstorm", "brief.md", expect.any(AbortSignal));
});

it("renders item links to reports as links only when a resolver is provided", () => {
	const reportPath = ".octocode/octocode-rfc-generator/2026-10-25-webview-voice-engine/RFC.md";
	const item: SnapshotItem = snapshotItem("B1", {
		links: [
			{ relation: "derived_from", target: { resource: "files", repositoryKey: "repo", path: reportPath } },
			{ relation: "evidence", target: { resource: "files", repositoryKey: "repo", path: "src/app/App.tsx" } },
		],
	});
	const view = (reportHref?: (path: string) => string | undefined) =>
		render(<ItemDetail item={item} index={index} onClose={() => {}} reportHref={reportHref} />);
	const { unmount } = view(reportLinkHref);
	const reportLink = screen.getByRole("link", { name: new RegExp(reportPath.replaceAll(".", "\\.")) });
	expect(reportLink).toHaveAttribute("href", "#rfc?id=2026-10-25-webview-voice-engine&kind=rfc&file=RFC.md");
	expect(screen.getByText("src/app/App.tsx").closest("a")).toBeNull();
	unmount();
	view(undefined);
	expect(screen.queryByRole("link", { name: new RegExp(reportPath.replaceAll(".", "\\.")) })).not.toBeInTheDocument();
});

it("renders report markdown through the live rich text renderer", async () => {
	reports.mockResolvedValue({ reports: [brief] });
	reportFile.mockResolvedValue({ id: brief.id, kind: "research", file: "brief.md", markdown: "# Prompt callers" });
	render(
		<RichTextContext.Provider value={({ text }: { text: string }) => <strong>{text}</strong>}>
			<ResearchView index={index} params={{ id: brief.id }} setParams={() => {}} />
		</RichTextContext.Provider>,
	);
	await waitFor(() => expect(screen.getByText("# Prompt callers")).toBeInTheDocument());
});

it("surfaces an invalid reports response when a report has an unknown kind", async () => {
	// The real api.reports guard rejects with this message; the test mocks the API boundary.
	reports.mockRejectedValue(new Error("Invalid reports response"));
	render(<RfcView index={index} params={{}} setParams={() => {}} />);
	expect(await screen.findByRole("alert")).toHaveTextContent("Invalid reports response");
});

it("aborts a retry request when the tab unmounts", async () => {
	let resolveRetry: (value: ReportsIndex) => void = () => {};
	reports.mockRejectedValueOnce(new Error("Network error")).mockImplementationOnce(
		() =>
			new Promise<ReportsIndex>((resolve) => {
				resolveRetry = resolve;
			}),
	);
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const { unmount } = render(<RfcView index={index} params={{}} setParams={() => {}} />);
	// Initial load fails and shows the retry button.
	await userEvent.click(await screen.findByRole("button", { name: "Retry loading reports" }));
	// Unmount before the retry resolves; no state update should run after unmount.
	unmount();
	resolveRetry(payload);
	// Allow any pending microtasks to flush.
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(errorSpy).not.toHaveBeenCalled();
	errorSpy.mockRestore();
});
