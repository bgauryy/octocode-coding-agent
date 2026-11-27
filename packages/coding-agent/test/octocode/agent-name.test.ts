import { describe, expect, it } from "vitest";
import { agentNameOf } from "../../src/octocode/shared/agent-name.ts";

describe("agentNameOf", () => {
	it("keeps one name per session, tells listeners only on a change, and stops when unsubscribed", () => {
		const session = {};
		const name = agentNameOf(session);
		expect(agentNameOf(session)).toBe(name);
		expect(agentNameOf({}).get()).toBeUndefined();
		const seen: Array<string | undefined> = [];
		const stop = name.subscribe(() => seen.push(name.get()));
		name.set("shy-barnacle");
		name.set("shy-barnacle"); // a refreshed join repaints nothing
		name.set(undefined); // left the team
		name.set("shy-barnacle-2"); // rejoined under a fresh name
		stop();
		name.set("other");
		expect(seen).toEqual(["shy-barnacle", undefined, "shy-barnacle-2"]);
	});

	it("lets a listener unsubscribe itself while being told", () => {
		const name = agentNameOf({});
		let calls = 0;
		const stop = name.subscribe(() => {
			calls++;
			stop();
		});
		let other = 0;
		name.subscribe(() => other++);
		name.set("a");
		name.set("b");
		expect([calls, other]).toEqual([1, 2]);
	});
});
