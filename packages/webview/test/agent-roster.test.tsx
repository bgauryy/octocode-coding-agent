import type { Member, Traffic } from "@octocodeai/octocode-contracts";
import { expect, it } from "vitest";
import { buildRoster, describeLast, lastMessage } from "../src/app/live/agent-roster.ts";

const message = (overrides: Partial<Traffic>): Traffic => ({
	id: 1,
	from: "main",
	to: ["worker"],
	text: "hi",
	at: 0,
	state: "delivered",
	...overrides,
});

it("describes an agent's newest message, clipped and without line breaks", () => {
	const traffic = [
		message({ id: 1, text: "old" }),
		message({ id: 2, from: "worker", to: ["main"], text: "Use  pnpm\nor yarn?", state: "awaiting reply" }),
		message({ id: 3, from: "main", to: ["other"], text: "unrelated" }),
	];
	expect(describeLast("worker", traffic[1])).toBe("↳ to main · awaiting reply · “Use pnpm or yarn?”");
	expect(describeLast("worker", message({ from: "main", text: "x".repeat(200), state: "queued" }))).toMatch(
		/^↳ from main · queued · “x{89}…”$/,
	);
	expect(lastMessage("worker", traffic)?.id).toBe(2);
	expect(lastMessage("main", traffic)?.id).toBe(3);
	expect(lastMessage("nobody", traffic)).toBeUndefined();
});

const member = (id: string, parentId?: string, pending?: number): Member =>
	({ id, parentId, pending, status: "idle" }) as Member;

it("does not flag a parent for a child's reply-required request, but does for other waiting messages", () => {
	const agents = [member("main"), member("lead", "main", 1), member("worker", "lead")];
	const ask = message({ from: "worker", to: ["lead"], state: "awaiting reply", replyRequired: true });
	const flagged = (traffic: Traffic[], list = agents) =>
		Object.fromEntries(
			buildRoster(list, traffic).flatMap(function walk(n): [string, boolean][] {
				return [[n.agent.id, n.attention], ...n.children.flatMap(walk)];
			}),
		);
	expect(flagged([ask]).lead).toBe(false);
	expect(flagged([message({ from: "main", to: ["lead"], state: "awaiting reply" })]).lead).toBe(true);
	expect(flagged([], [member("main"), member("lead", "main", 1)]).lead).toBe(true);
});
