/** @vitest-environment jsdom */
import type { ApplicationAwaiting, Question } from "@octocodeai/octocode-contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityView } from "../src/app/live/ActivityView.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import { controlView, fetchControl, posted, receipt, setupControls } from "./control-fixtures.tsx";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

const index = indexBacklog({
	repo: "r",
	generatedAt: 0,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1,
	items: [],
});
const activity = () => <ActivityView index={index} params={{}} setParams={() => {}} />;
const session = {
	streaming: true,
	runId: "run-1",
	capabilities: ["prompt", "steer", "followUp", "abort", "answer"] as (
		| "prompt"
		| "steer"
		| "followUp"
		| "abort"
		| "answer"
	)[],
};
const holds = () => posted().filter((command) => command.action === "hold");

/** A timed card with a write-in: the host takes "Small" in 20 seconds. */
const timed: ApplicationAwaiting = {
	kind: "question",
	title: "Which scope?",
	id: "d1",
	options: ["Small (Recommended)", "Large"],
	optionInfo: [{ recommended: true }, {}],
	allowsText: true,
	timeoutSeconds: 20,
};

it("stops the host's countdown at the first keystroke in the write-in, once, and the card stops counting", async () => {
	const view = controlView(activity());
	await view.workspace();
	await view.session({ ...session, awaiting: timed });
	expect(screen.getByRole("timer").textContent).toMatch(/^auto: Small in \d+s$/);
	await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "Med");
	await waitFor(() => expect(holds()).toEqual([expect.objectContaining({ action: "hold", dialogId: "d1" })]));
	expect(screen.queryByRole("timer")).toBeNull();
	// The person's own answer follows the hold.
	await userEvent.click(screen.getByRole("button", { name: "Answer" }));
	await waitFor(() => expect(posted().at(-1)).toMatchObject({ action: "answer", dialogId: "d1", text: "Med" }));
	expect(holds()).toHaveLength(1);
});

it("stops the host's countdown at a click on an option", async () => {
	const view = controlView(activity());
	await view.workspace();
	await view.session({ ...session, awaiting: timed });
	await userEvent.click(screen.getByRole("button", { name: /^Large/ }));
	await waitFor(() => expect(holds()).toHaveLength(1));
	expect(posted().findIndex((command) => command.action === "hold")).toBeLessThan(
		posted().findIndex((command) => command.action === "answer"),
	);
	expect(screen.queryByRole("timer")).toBeNull();
});

it("stops the host's countdown when a batch's radio or write-in is touched", async () => {
	const question: Question = {
		id: "q1",
		type: "choice",
		question: "Continue?",
		timeoutSeconds: 20,
		options: [
			{ id: "1", label: "Continue (Recommended)", recommended: true },
			{ id: "2", label: "Stop" },
		],
	};
	const view = controlView(activity());
	await view.workspace();
	await view.session({
		...session,
		awaiting: { kind: "question", title: "Continue?", id: "d2", questions: [question] },
	});
	expect(screen.getByRole("timer")).toBeInTheDocument();
	await userEvent.click(screen.getByRole("radio", { name: /Stop/ }));
	await waitFor(() => expect(holds()).toEqual([expect.objectContaining({ dialogId: "d2" })]));
	expect(screen.queryByRole("timer")).toBeNull();
});

it("sends no hold from a card without a countdown", async () => {
	const view = controlView(activity());
	await view.workspace();
	const { timeoutSeconds: _timeout, ...plain } = timed;
	await view.session({ ...session, awaiting: plain });
	await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "Med");
	await userEvent.click(screen.getByRole("button", { name: /^Large/ }));
	await waitFor(() => expect(posted().some((command) => command.action === "answer")).toBe(true));
	expect(holds()).toHaveLength(0);
});

it("shows the countdown again, and says why, when the host refuses the hold", async () => {
	const view = controlView(activity());
	await view.workspace();
	await view.session({ ...session, awaiting: timed });
	fetchControl.mockImplementation(async (_url, init) =>
		receipt(init, JSON.parse(String(init?.body)).action === "hold" ? "failed" : "accepted", "No such dialog is open"),
	);
	await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "M");
	await waitFor(() => expect(screen.getByText("No such dialog is open")).toBeInTheDocument());
	expect(screen.getByRole("timer")).toBeInTheDocument();
});
