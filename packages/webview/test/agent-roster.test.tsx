/** @vitest-environment jsdom */
import type { Traffic } from "@octocodeai/octocode-contracts";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsView } from "../src/app/live/AgentsView.tsx";
import { buildRoster, describeLast } from "../src/app/live/agent-roster.ts";
import { controlView, member, setupControls } from "./control-fixtures.tsx";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

const message = (overrides: Partial<Traffic>): Traffic => ({
	id: 1,
	from: "main",
	to: ["worker"],
	text: "hi",
	at: 0,
	state: "delivered",
	...overrides,
});

it("nests children under their parent and sorts attention first, then working, then idle", () => {
	const roster = buildRoster(
		[
			member({ id: "idle-root", role: "main", status: "idle" }),
			member({ id: "busy-root", role: "main", status: "working" }),
			member({ id: "kid-idle", parentId: "busy-root", status: "idle" }),
			member({ id: "kid-ask", parentId: "busy-root", status: "idle", pending: 1 }),
			member({ id: "orphan", parentId: "gone", status: "idle" }),
		],
		[],
	);
	expect(roster.map((node) => node.agent.id)).toEqual(["busy-root", "idle-root", "orphan"]);
	expect(roster[0].children.map((node) => node.agent.id)).toEqual(["kid-ask", "kid-idle"]);
	expect(roster[0].children[0].attention).toBe(true);
});

it("keeps every member of a parent cycle", () => {
	const roster = buildRoster([member({ id: "a", parentId: "b" }), member({ id: "b", parentId: "a" })], []);
	const ids = (nodes: typeof roster): string[] => nodes.flatMap((node) => [node.agent.id, ...ids(node.children)]);
	expect(ids(roster).sort()).toEqual(["a", "b"]);
});

it("flags an agent whose incoming message awaits a reply and describes its newest message", () => {
	const traffic = [
		message({ id: 1, text: "old" }),
		message({ id: 2, from: "worker", to: ["main"], text: "Use  pnpm\nor yarn?", state: "awaiting reply" }),
		message({ id: 3, from: "main", to: ["other"], text: "unrelated" }),
	];
	expect(describeLast("worker", traffic[1])).toBe("↳ to main · awaiting reply · “Use pnpm or yarn?”");
	expect(describeLast("worker", message({ from: "main", text: "x".repeat(200), state: "queued" }))).toMatch(
		/^↳ from main · queued · “x{89}…”$/,
	);
	const roster = buildRoster([member({ id: "main", role: "main" }), member({ id: "worker" })], traffic);
	const main = roster.find((node) => node.agent.id === "main");
	expect(main?.attention).toBe(true);
	expect(main?.last?.id).toBe(3);
	expect(roster.find((node) => node.agent.id === "worker")?.last?.id).toBe(2);
});

it("renders the tree with each agent's last message, pending count and locks", async () => {
	const view = controlView(<AgentsView />);
	await view.workspace({
		agents: [
			member({ id: "main", role: "main", status: "idle" }),
			member({ id: "inky", parentId: "main", pending: 2, locks: ["src/a.ts", "src/b/"] }),
		],
		traffic: [message({ from: "inky", to: ["main"], text: "Use pnpm?", state: "awaiting reply" })],
	});
	const lists = screen.getAllByRole("list", { name: "Agents" });
	expect(lists).toHaveLength(1);
	const nested = within(screen.getByRole("heading", { name: "main", level: 3 }).closest("li") as HTMLElement);
	expect(nested.getByRole("heading", { name: "inky" })).toBeInTheDocument();
	expect(screen.getByText("2 awaiting reply")).toBeInTheDocument();
	expect(screen.getByText("↳ to main · awaiting reply · “Use pnpm?”")).toBeInTheDocument();
	expect(screen.getByText("↳ from inky · awaiting reply · “Use pnpm?”")).toBeInTheDocument();
	expect(screen.getByText("src/a.ts, src/b/")).toBeInTheDocument();
});
