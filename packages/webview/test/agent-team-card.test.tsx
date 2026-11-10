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
			agents={[agent("main", { role: "main" }), agent("kid", { parentId: "main" })]}
			requests={new Map()}
			timeline={undefined}
			width={380}
			onWidth={vi.fn()}
			onSelect={vi.fn()}
			onStep={vi.fn()}
		/>
	);
}

it("shows how a member's run ended and what it waits for on its team card", async () => {
	const view = controlView(drawer("kid"));
	await view.workspace({
		agents: [
			member({
				id: "kid",
				role: "implementer",
				outcome: "blocked",
				headline: "needs a schema decision",
				waiting: "approval",
			}),
		],
	});
	const team = await screen.findByLabelText("Team");
	expect(within(team).getByText("Waiting for your approval")).toBeInTheDocument();
	expect(within(team).getByText("Ended: blocked · needs a schema decision")).toBeInTheDocument();
});
