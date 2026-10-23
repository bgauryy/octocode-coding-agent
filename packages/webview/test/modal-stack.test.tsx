/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { Sheet } from "../src/app/ui/Sheet.tsx";

function Layers({ a = false, b = false, c = false }: { a?: boolean; b?: boolean; c?: boolean }) {
	return (
		<>
			<button type="button">Page opener</button>
			{a && (
				<Sheet label="A" onClose={() => {}} initialFocus={() => document.getElementById("a-focus")}>
					<button id="a-focus" type="button">
						Open B
					</button>
				</Sheet>
			)}
			{b && (
				<Sheet label="B" onClose={() => {}} initialFocus={() => document.getElementById("b-focus")}>
					<button id="b-focus" type="button">
						Open C
					</button>
				</Sheet>
			)}
			{c && (
				<Sheet label="C" onClose={() => {}} initialFocus={() => document.getElementById("c-focus")}>
					<button id="c-focus" type="button">
						Close C
					</button>
				</Sheet>
			)}
		</>
	);
}

it("restores the connected page opener after lower dialogs close under a third dialog", async () => {
	const view = render(<Layers />);
	const page = screen.getByRole("button", { name: "Page opener" });
	page.focus();
	view.rerender(<Layers a />);
	expect(screen.getByRole("button", { name: "Open B" })).toHaveFocus();
	view.rerender(<Layers a b />);
	expect(screen.getByRole("button", { name: "Open C" })).toHaveFocus();
	view.rerender(<Layers a b c />);
	const top = screen.getByRole("button", { name: "Close C" });
	expect(top).toHaveFocus();
	view.rerender(<Layers b c />);
	view.rerender(<Layers c />);
	expect(top).toHaveFocus();
	expect(document.body.style.overflow).toBe("hidden");
	view.rerender(<Layers />);
	await waitFor(() => expect(page).toHaveFocus());
	expect(document.body.style.overflow).toBe("");
});
