/** @vitest-environment jsdom */
import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { titleWithCount } from "../src/app/model/needs-you.ts";
import { posted, setupControls } from "./control-fixtures.tsx";
import { FakeSocket } from "./helpers.ts";

const BASE_TITLE = "Octocode workspace";
const awaiting = {
	kind: "approval" as const,
	title: "Run rm -rf build?",
	id: "d1",
	options: ["Allow once", "Deny"],
	allowsText: false,
};
const ANSWERABLE = ["prompt", "steer", "followUp", "abort", "answer"] as const;
let sequence = 0;

beforeEach(() => {
	setupControls();
	sequence = 0;
	document.title = BASE_TITLE;
});
afterEach(() => vi.unstubAllGlobals());

async function open(hash: string) {
	history.replaceState(null, "", hash);
	const backlog = createBacklogStore({
		repo: "r",
		generatedAt: 0,
		states: ["backlog", "todo", "ongoing", "done"],
		idleMs: 1,
		items: [],
	});
	const view = render(<App backlog={backlog} live={live} access="test" />);
	const send = async (overrides: Partial<ApplicationSnapshot>) => {
		act(() =>
			FakeSocket.instances[0].receive("application", {
				protocolVersion: 1,
				cursor: { sessionId: "s", epoch: "epoch-s", sequence: sequence++ },
				at: 0,
				type: "snapshot",
				snapshot: {
					sessionId: "s",
					messages: [],
					streaming: true,
					runId: "run-1",
					steering: [],
					followUp: [],
					receipts: [],
					capabilities: [...ANSWERABLE],
					...overrides,
				},
			}),
		);
		await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
	};
	return { ...view, send };
}

it("shows no pill and leaves the title alone while nothing waits", async () => {
	const view = await open("#board");
	await view.send({});
	expect(screen.queryByRole("button", { name: /needs you/ })).toBeNull();
	expect(document.title).toBe(BASE_TITLE);
});

it("shows a header pill and a title prefix on any view, answers inline, then clears both", async () => {
	const view = await open("#board");
	await view.send({ awaiting });
	const pill = await screen.findByRole("button", { name: "1 needs you" });
	expect(document.title).toBe(`(1) ${BASE_TITLE}`);
	expect(pill).toHaveAttribute("aria-expanded", "false");
	expect(location.hash).toBe("#board");

	await userEvent.click(pill);
	const panel = document.getElementById("needs-you-panel") as HTMLElement;
	expect(pill).toHaveAttribute("aria-expanded", "true");
	expect(within(panel).getByText("Run rm -rf build?")).toBeInTheDocument();
	await waitFor(() => expect(within(panel).getByRole("button", { name: "Allow once" })).toHaveFocus());
	expect(location.hash).toBe("#board");

	await userEvent.click(within(panel).getByRole("button", { name: "Allow once" }));
	await waitFor(() =>
		expect(posted().at(-1)).toMatchObject({ action: "answer", dialogId: "d1", choice: "Allow once" }),
	);

	await view.send({ awaiting: undefined });
	await waitFor(() => expect(screen.queryByRole("button", { name: /needs you/ })).toBeNull());
	expect(document.getElementById("needs-you-panel")).toBeNull();
	expect(document.title).toBe(BASE_TITLE);
});

it("offers 'Answer waiting question' in the palette only while something waits", async () => {
	const view = await open("#board");
	await view.send({});
	await userEvent.keyboard("{Control>}k{/Control}");
	await userEvent.keyboard("answer waiting");
	expect(screen.queryByRole("option", { name: /Answer waiting question/ })).toBeNull();
	await userEvent.keyboard("{Escape}");

	await view.send({ awaiting });
	await userEvent.keyboard("{Control>}k{/Control}");
	await userEvent.keyboard("answer waiting");
	await userEvent.click(await screen.findByRole("option", { name: /Answer waiting question/ }));
	const panel = await waitFor(() => {
		const found = document.getElementById("needs-you-panel");
		expect(found).not.toBeNull();
		return found as HTMLElement;
	});
	expect(within(panel).getByRole("button", { name: "Deny" })).toBeInTheDocument();
});

it("points to the terminal when this page cannot answer", async () => {
	const view = await open("#board");
	await view.send({ awaiting, capabilities: ["prompt"] });
	expect(document.title).toBe(`(1) ${BASE_TITLE}`);
	await userEvent.click(await screen.findByRole("button", { name: "1 needs you" }));
	const panel = document.getElementById("needs-you-panel") as HTMLElement;
	expect(within(panel).getByText(/Answer it in the terminal/)).toBeInTheDocument();
	expect(within(panel).queryByRole("button", { name: "Allow once" })).toBeNull();
});

it("moves to the composer's dialog on Activity instead of showing a second one, with one truthful sentence", async () => {
	const view = await open("#activity");
	await view.send({ awaiting });
	const pill = await screen.findByRole("button", { name: "1 needs you" });
	await userEvent.click(pill);
	expect(document.getElementById("needs-you-panel")).toBeNull();
	expect(screen.getAllByRole("button", { name: "Allow once" })).toHaveLength(1);
	expect(screen.getByRole("button", { name: "Allow once" })).toHaveFocus();
	expect(screen.getAllByText("Approvals and questions can be answered here or in the terminal.")).not.toHaveLength(0);
	expect(screen.queryByText("Approvals appear in the terminal.")).toBeNull();
	await view.send({ capabilities: ["prompt"] });
	expect(screen.queryByText(/can be answered here/)).toBeNull();
	expect(screen.getAllByText("Approvals appear in the terminal.")).not.toHaveLength(0);
});

it("strips an existing count prefix before applying a new one", () => {
	expect(titleWithCount("(1) Octocode", 2)).toBe("(2) Octocode");
	expect(titleWithCount("(2) Octocode", 0)).toBe("Octocode");
});
