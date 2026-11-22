/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigProviderCommand,
	type ConfigSnapshot,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

afterEach(cleanup);

const snapshot: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 22),
	keychainAvailable: true,
	providers: [
		{
			provider: "gateway",
			name: "My gateway",
			configured: true,
			sources: [{ kind: "keychain" }],
			models: ["m1", "m2", "m3"],
			modelChoice: { ids: ["m1", "m2", "m3"], hidden: ["m3", "gone"] },
		},
	],
	settings: [],
	writable: true,
};

describe("provider model checkboxes", () => {
	it("ticks what is not hidden and saves the unticked ids with the unlisted hidden ones", async () => {
		const saveProvider = vi.fn(async (_command: ConfigProviderCommand) => snapshot);
		render(<ConfigView load={async () => snapshot} saveProvider={saveProvider} />);
		expect(await screen.findByText("2 of 3 shown")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Choose models of My gateway" }));
		const boxes = screen.getAllByRole("checkbox");
		expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, false]);
		await userEvent.click(boxes[0]);
		await userEvent.click(screen.getByRole("button", { name: "Save models" }));
		expect(saveProvider.mock.calls[0]?.[0]).toEqual({
			action: "set-models",
			provider: "gateway",
			hidden: ["gone", "m1", "m3"],
		});
	});

	it("searches the list", async () => {
		render(<ConfigView load={async () => snapshot} saveProvider={vi.fn()} />);
		await userEvent.click(await screen.findByRole("button", { name: "Choose models of My gateway" }));
		await userEvent.type(screen.getByLabelText("Search models of My gateway"), "m2");
		expect(screen.getAllByRole("checkbox")).toHaveLength(1);
	});
});
