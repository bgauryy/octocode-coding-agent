/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createBacklogStore } from "../src/app/extension.ts";
import { DiffView } from "../src/app/live/DiffView.tsx";
import { RunIndicator, ThoughtFor } from "../src/app/live/RunIndicator.tsx";
import { TerminalTranscript } from "../src/app/live/TerminalView.tsx";
import { Button } from "../src/app/ui/primitives.tsx";

describe("loaders", () => {
	it("marks a loading button busy, keeps its label and blocks repeat clicks", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(
			<Button loading onClick={onClick}>
				Save item
			</Button>,
		);
		const button = screen.getByRole("button", { name: "Save item" });
		expect(button).toHaveAttribute("aria-busy", "true");
		expect(button).toBeDisabled();
		await user.click(button);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("shows a loading board instead of an empty one until the first snapshot arrives", () => {
		history.replaceState(null, "", "#board");
		const empty = {
			repo: "r",
			generatedAt: 0,
			states: ["backlog", "todo", "ongoing", "done"] as const,
			idleMs: 1,
			items: [],
		};
		const store = createBacklogStore(empty, false);
		render(<App backlog={store} live={null} />);
		expect(screen.getByRole("status", { name: "Loading board" })).toBeInTheDocument();
		expect(screen.queryByText("Your next idea starts here")).not.toBeInTheDocument();
		act(() => store.getState().setSnapshot(empty));
		expect(screen.queryByRole("status", { name: "Loading board" })).not.toBeInTheDocument();
		expect(screen.getByText("Your next idea starts here")).toBeInTheDocument();
	});
});

describe("run indicator", () => {
	beforeEach(() => vi.useFakeTimers({ now: 10_000 }));
	afterEach(() => vi.useRealTimers());

	it("names the phase and counts elapsed seconds while a run is active", () => {
		const { rerender } = render(<RunIndicator phase={{ kind: "thinking" }} startedAt={7_000} />);
		expect(screen.getByText("Thinking")).toBeInTheDocument();
		expect(screen.getByText("3s")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(2_000));
		expect(screen.getByText("5s")).toBeInTheDocument();
		rerender(<RunIndicator phase={{ kind: "tool", name: "bash" }} startedAt={7_000} />);
		expect(screen.getByText("Running bash")).toBeInTheDocument();
		rerender(<RunIndicator phase={{ kind: "idle" }} startedAt={7_000} />);
		expect(screen.queryByText(/Running|Thinking|Writing/)).not.toBeInTheDocument();
	});

	it("summarizes thinking time on the answer", () => {
		render(<ThoughtFor ms={12_400} />);
		expect(screen.getByText("Thought for 12s")).toBeInTheDocument();
	});
});

describe("terminal transcript", () => {
	beforeEach(() => vi.useFakeTimers({ now: 5_000 }));
	afterEach(() => vi.useRealTimers());

	it("renders each tool call as a prompt line with its status and output", () => {
		render(
			<TerminalTranscript
				entries={[
					{ id: 1, at: 1_000, command: "bash", output: "npm test\n3 passed", status: "done" },
					{ id: 2, at: 2_000, command: "edit", output: "", status: "failed" },
					{ id: 3, at: 4_000, command: "grep", output: "aria-modal", status: "running" },
				]}
			/>,
		);
		const log = screen.getByRole("log", { name: "Terminal transcript" });
		const entries = within(log).getAllByRole("listitem");
		expect(entries).toHaveLength(3);
		expect(within(entries[0]).getByText("bash")).toBeInTheDocument();
		expect(within(entries[0]).getByText(/3 passed/)).toBeInTheDocument();
		expect(within(entries[1]).getByText("failed")).toBeInTheDocument();
		expect(within(entries[2]).getByText("running · 1s")).toBeInTheDocument();
	});

	it("explains an empty transcript", () => {
		render(<TerminalTranscript entries={[]} />);
		expect(screen.getByText("No commands yet")).toBeInTheDocument();
	});
});

describe("file diffs", () => {
	it("shows each changed file with added and removed counts and marks every line", () => {
		render(
			<DiffView
				diffs={[
					{
						path: "src/a.ts",
						type: "edit",
						diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context",
					},
				]}
			/>,
		);
		const file = screen.getByRole("figure", { name: "src/a.ts: 1 added, 1 removed" });
		expect(within(file).getByText("+new line")).toHaveClass("diff-add");
		expect(within(file).getByText("-old line")).toHaveClass("diff-del");
		expect(within(file).getByText("@@ -1,2 +1,2 @@")).toHaveClass("diff-hunk");
	});
});
