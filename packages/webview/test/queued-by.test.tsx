/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardMeta } from "../src/app/features/BoardCard.tsx";
import { ItemFlow } from "../src/app/features/ItemFlow.tsx";
import { snapshotItem } from "./helpers.ts";

describe("an item an agent is queued to start", () => {
	it("shows who is queued on the card", () => {
		render(<CardMeta item={snapshotItem("B14", { queuedBy: "nimble-kelp", blockedBy: ["B12"] })} childrenDone={0} />);
		expect(screen.getByText("queued: nimble-kelp")).toBeTruthy();
	});

	it("shows no queued badge without a queued agent", () => {
		render(<CardMeta item={snapshotItem("B14")} childrenDone={0} />);
		expect(screen.queryByText(/queued:/)).toBeNull();
	});

	it("draws the pending dependency edge in the flow", () => {
		const { container } = render(
			<ItemFlow item={snapshotItem("B14", { queuedBy: "nimble-kelp", blockedBy: ["B12"] })} />,
		);
		const edge = container.querySelector("[data-pending]");
		expect(edge?.textContent).toBe("B12 → B14 (pending): queued for nimble-kelp");
	});

	it("draws no edge for an item nobody is queued for", () => {
		const { container } = render(<ItemFlow item={snapshotItem("B14", { blockedBy: ["B12"] })} />);
		expect(container.querySelector("[data-pending]")).toBeNull();
	});
});
