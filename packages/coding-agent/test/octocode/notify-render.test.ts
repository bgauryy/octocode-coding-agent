import { describe, expect, it } from "vitest";
import { timerTool } from "../../src/octocode/native/tools/notify/tool.ts";
import { notifyState } from "../../src/octocode/native/tools/notify/row.ts";
import { rendered, theme } from "./fake-host.ts";

const tool = timerTool({} as never);
const call = (args: Record<string, unknown>) => rendered(tool.renderCall!(args as never, theme, {} as never));
const display = (args: Record<string, unknown>) =>
	tool.display!({ args, status: "running" } as never) as never as {
		display?: unknown;
	};

describe("the notify row reads as a notification request", () => {
	it("names a clock request by its time", () => {
		expect(call({ op: "set", after: 90, note: "check the build" })).toContain(
			'Notify me when(in 90s "check the build")',
		);
		expect(call({ op: "set", every: 60 })).toContain("Notify me when(every 60s)");
		expect(call({ op: "set", cron: "0 9 * * 1-5" })).toContain("cron 0 9 * * 1-5");
	});

	it("names an event request by its event and filter", () => {
		const row = call({ op: "on", event: "item.state", filter: { ref: "B7", state: "done" }, note: "merge" });
		expect(row).toContain("Notify me when");
		expect(row).toContain("B7");
	});

	it("names a command request by its command", () => {
		const row = call({ op: "on", event: "check.result", filter: { command: "test -e out.txt" } });
		expect(row).toContain("Notify me when");
		expect(row).toContain("test -e out.txt");
	});

	it("says what off removed", () => {
		expect(call({ op: "off", id: 3 })).toContain("Notify off(3)");
		expect(call({ op: "off", all: true })).toContain("Notify off(all)");
	});

	it("says what list listed", () => {
		expect(call({ op: "list" })).toMatch(/Notify list/);
		expect(call({ op: "list", all: true })).toContain("Notify list(all)");
	});

	it("shows an accepted request as pending until it fires; off, list and failures keep their own state", () => {
		expect(notifyState({ op: "set", after: 5 }, false)).toBe("pending");
		expect(notifyState({ op: "on", event: "agent.ended" }, false)).toBe("pending");
		expect(notifyState({ op: "off", id: 1 }, false)).toBeUndefined();
		expect(notifyState({ op: "list" }, false)).toBeUndefined();
		expect(notifyState({ op: "set", after: 5 }, true)).toBeUndefined();
	});

	it("tolerates malformed arguments while the call renders", () => {
		expect(call({ op: "on", event: 5, note: 7 })).toContain("Notify me when");
		expect(display({ op: "set", after: 5 })).toBeDefined();
	});
});
