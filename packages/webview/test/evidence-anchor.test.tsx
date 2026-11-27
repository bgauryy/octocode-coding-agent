/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { EvidenceContext, type EvidenceReader } from "../src/app/live/evidence.tsx";
import { Markdown } from "../src/app/live/Markdown.tsx";

const anchor = "archive:s/1/e-1";
const view = (read: EvidenceReader, text = `see ${anchor} for the wording`) =>
	render(
		<EvidenceContext.Provider value={read}>
			<Markdown text={text} />
		</EvidenceContext.Provider>,
	);
const base = { anchor: { kind: "archive", sessionId: "s", segment: 1, entryId: "e-1" } } as const;

it("opens an anchor in a message and pages with More", async () => {
	const read = vi
		.fn<EvidenceReader>()
		.mockResolvedValueOnce({ ...base, availability: "present", author: "user", text: "one ", nextCursor: "c2" })
		.mockResolvedValueOnce({ ...base, availability: "present", text: "two" });
	view(read);
	await userEvent.click(screen.getByRole("button", { name: anchor }));
	expect(await screen.findByText("one")).toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "More" }));
	expect(await screen.findByText(/one\s+two/)).toBeInTheDocument();
	expect(read).toHaveBeenLastCalledWith(anchor, "c2");
});

it("shows a missing anchor neutrally", async () => {
	view(async () => ({ ...base, availability: "missing" }));
	await userEvent.click(screen.getByRole("button", { name: anchor }));
	expect(await screen.findByText(/not available/)).toBeInTheDocument();
});

it("keeps malformed anchors as text", () => {
	view(vi.fn(), "archive:oops is not one");
	expect(screen.queryByRole("button")).toBeNull();
});
