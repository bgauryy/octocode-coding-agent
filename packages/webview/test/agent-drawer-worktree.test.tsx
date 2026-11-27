/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Drawer } from "../src/app/live/profiler/Drawer.tsx";
import { controlView, member, setupControls } from "./control-fixtures.tsx";
import { agent } from "./profiler-fixtures.ts";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

function drawer(id: string) {
	return (
		<Drawer
			selection={{ kind: "agent", agentId: id }}
			agents={[
				agent("main", { role: "main" }),
				agent("iso-kid", { parentId: "main" }),
				agent("plain", { parentId: "main" }),
			]}
			requests={new Map()}
			timeline={undefined}
			width={380}
			onWidth={vi.fn()}
			onSelect={vi.fn()}
			onStep={vi.fn()}
		/>
	);
}

it("shows the worktree an isolated agent works in on its team card, with the full path on hover", async () => {
	const path = "/home/u/.octocode/worktrees/iso-kid";
	const view = controlView(drawer("iso-kid"));
	await view.workspace({ agents: [member({ id: "iso-kid", role: "implementer", worktree: path })] });
	const team = await screen.findByLabelText("Team");
	expect(within(team).getByText("iso-kid", { selector: "code" })).toBeInTheDocument();
	expect(within(team).getByText(/Worktree:/)).toHaveAttribute("title", path);
});

it("shows no worktree line for an agent that shares the workspace", async () => {
	const view = controlView(drawer("plain"));
	await view.workspace({ agents: [member({ id: "plain", role: "explorer", pending: 1 })] });
	expect(await screen.findByLabelText("Team")).toBeInTheDocument();
	expect(screen.queryByText(/Worktree:/)).toBeNull();
});
