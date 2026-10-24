/** @vitest-environment jsdom */
import type { BacklogAudit } from "@octocodeai/octocode-contacts/snapshot";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AuditView } from "../src/app/live/AuditView.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";

const { audit, live } = vi.hoisted(() => {
	const audit = vi.fn();
	return { audit, live: { api: { audit } } };
});
vi.mock("../src/app/live/session.tsx", () => ({ useLive: () => live }));
const index = indexBacklog({ repo: "r", generatedAt: 0, states: [], idleMs: 1, items: [] });
const event = (id: number): BacklogAudit => ({
	id,
	backlogId: "B1",
	at: id,
	actor: { id: "user" },
	entity: "backlog",
	action: "update",
	before: { title: "Old" },
	after: { title: `Change ${id}` },
});
beforeEach(() => audit.mockReset());

it("lets the reader retry an initial history failure without leaving the view", async () => {
	audit.mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValueOnce({ events: [event(8)] });
	render(<AuditView index={index} params={{ backlogId: "B1" }} setParams={() => {}} />);
	expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
	await userEvent.click(screen.getByRole("button", { name: "Retry loading history" }));
	await screen.findByText('"Change 8"');
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(audit).toHaveBeenLastCalledWith({ backlogId: "B1", before: undefined }, expect.any(AbortSignal));
});

it("retries the failed older-page cursor while keeping loaded history", async () => {
	audit
		.mockResolvedValueOnce({ events: [event(8)], before: 8 })
		.mockRejectedValueOnce(new Error("Try again"))
		.mockResolvedValueOnce({ events: [event(4)] });
	render(<AuditView index={index} params={{}} setParams={() => {}} />);
	await userEvent.click(await screen.findByRole("button", { name: "Load older events" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
	expect(screen.getByText('"Change 8"')).toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "Retry loading history" }));
	await waitFor(() => expect(screen.getByText('"Change 4"')).toBeInTheDocument());
	expect(screen.getByText('"Change 8"')).toBeInTheDocument();
	expect(audit.mock.calls.slice(1).map(([query]) => query.before)).toEqual([8, 8]);
});
