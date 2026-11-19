/** @vitest-environment jsdom */
import type { SecurityActionCommand, SecurityList } from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityPanel } from "../src/app/config/SecurityPanel.tsx";

afterEach(cleanup);

const list: SecurityList = {
	items: [
		{
			id: "mcp:docs",
			kind: "mcp",
			label: "docs",
			path: "~/.claude.json",
			scope: "global",
			state: "approved",
			rating: "HIGH",
			changed: true,
			withheld: true,
			grants: ["runs a program"],
			findings: [{ rule: "secret-env", rating: "HIGH", text: "Passes a secret-named variable." }],
			changes: ["~ .mcp.json", "- old", "+ new"],
		},
		{
			id: "skill:/u/demo/SKILL.md",
			kind: "skill",
			label: "demo",
			path: "/u/demo/SKILL.md",
			scope: "workspace",
			state: "not checked",
			rating: "LOW",
			changed: false,
			withheld: true,
			grants: ["instructions"],
			findings: [],
		},
	],
	workspace: { trusted: true },
};

describe("SecurityPanel", () => {
	it("lists items with rating, findings and the changes since approval", async () => {
		render(<SecurityPanel api={{ list: async () => list, act: vi.fn() }} reloadKey="k" />);
		const items = await screen.findByRole("list", { name: "Reviewed items" });
		expect(within(items).getByText("docs")).toBeTruthy();
		expect(within(items).getByText("Changed since approval")).toBeTruthy();
		expect(within(items).getByText("HIGH")).toBeTruthy();
		expect(within(items).getByText("Changed since you approved it")).toBeTruthy();
		expect(items.textContent).toContain("+ new");
		expect(items.textContent).toContain("secret-env");
		expect(within(items).getByText("Not checked")).toBeTruthy();
	});

	it("sends a confirmed decision and shows the fresh list", async () => {
		const act = vi.fn(async (_command: SecurityActionCommand): Promise<SecurityList> => ({
			items: [{ ...list.items[1]!, state: "approved", withheld: false }],
			message: "Approved demo.",
		}));
		render(<SecurityPanel api={{ list: async () => list, act }} repoId="r1" reloadKey="k" />);
		await userEvent.click(await screen.findByRole("button", { name: "Approve demo" }));
		expect(act).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Confirm approve for demo" }));
		expect(act).toHaveBeenCalledWith({ id: "skill:/u/demo/SKILL.md", action: "approve", repoId: "r1" });
		expect(await screen.findByText("Approved demo.")).toBeTruthy();
		expect(screen.queryByText("docs")).toBeNull();
	});

	it("shows the host's refusal and explains itself without an api", async () => {
		const act = vi.fn().mockRejectedValue(new Error("not read in full"));
		render(<SecurityPanel api={{ list: async () => list, act }} reloadKey="k" />);
		await userEvent.click(await screen.findByRole("button", { name: "Deny demo" }));
		await userEvent.click(screen.getByRole("button", { name: "Confirm deny for demo" }));
		expect((await screen.findByRole("alert")).textContent).toContain("not read in full");
		cleanup();
		render(<SecurityPanel reloadKey="k" />);
		expect(screen.getByText(/Reviews are made through/)).toBeTruthy();
	});
});
