/** @vitest-environment jsdom */
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsView } from "../src/app/live/AgentsView.tsx";
import { controlView, member, setupControls } from "./control-fixtures.tsx";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

it("shows the worktree folder of an agent that works outside the main checkout, and nothing for the others", async () => {
	const view = controlView(<AgentsView />);
	await view.workspace({
		agents: [
			member({ id: "main", role: "main", status: "idle" }),
			member({ id: "iso-kid", parentId: "main", worktree: "/home/u/.octocode/worktrees/iso-kid" }),
			member({ id: "plain-kid", parentId: "main" }),
		],
		traffic: [],
	});
	const folder = screen.getByText("iso-kid", { selector: "code" });
	expect(folder.closest("p")).toHaveAttribute("title", "/home/u/.octocode/worktrees/iso-kid");
	expect(screen.getAllByText(/^Worktree:/)).toHaveLength(1);
});
