import type { Traffic } from "@octocodeai/octocode-contracts";
import { expect, it } from "vitest";
import { describeLast, lastMessage } from "../src/app/live/agent-roster.ts";

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
