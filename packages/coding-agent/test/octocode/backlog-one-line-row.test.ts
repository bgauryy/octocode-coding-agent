import { describe, expect, it, vi } from "vitest";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeHost, rendered, theme } from "./fake-host.ts";

/** A successful change names its operation, item and title once, in the header; the duration shows from one second. */
function backlogTool() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	return fake.tools.get("backlog");
}

const item = { ref: "B561", state: "done", title: "Idle timeout on provider model streams" };

function draw(args: Record<string, unknown>, text: string, details: Record<string, unknown>, durationMs?: number) {
	const tool = backlogTool();
	const state = {};
	const invalidate = vi.fn();
	const context = { args, state, invalidate, isPartial: false, expanded: false, durationMs };
	const header = () => rendered(tool.renderCall(args, theme, context));
	const before = header();
	const result = rendered(
		tool.renderResult({ content: [{ type: "text", text }], details }, { expanded: false }, theme, context),
	);
	return { before, result, header: header(), invalidate };
}

describe("backlog rows say it once", () => {
	it("heads a finished item with `Backlog(B561 → done) · Title` and draws no result line", async () => {
		const out = draw({ op: "done", id: "B561" }, "B561 [done p2] x", { item }, 21);
		expect(out.before).toBe("✓ Backlog(done B561)");
		await Promise.resolve();
		expect(out.invalidate).toHaveBeenCalledTimes(1);
		expect(out.header).toBe("✓ Backlog(B561 → done) · Idle timeout on provider model streams");
		expect(out.result).toBe("");
	});

	it.each([
		[{ op: "claim", id: "B561" }, { ...item, state: "ongoing" }, "B561 → ongoing) · "],
		[{ op: "note", id: "B561", note: "n" }, { ...item, state: "ongoing" }, "B561 → ongoing) · "],
		[{ op: "close", id: "B561" }, { ...item, closed: true }, "B561 → closed) · "],
		[{ op: "add", items: [{ title: "T" }] }, { ...item, state: "backlog" }, "Added B561 · backlog) · "],
	])("heads %j once", (args, details, head) => {
		const out = draw(args, "line one", { item: details });
		expect(out.header).toContain(`Backlog(${head}`);
		expect(out.header.split("B561").length).toBe(2);
		expect(out.result).toBe("");
	});

	it("keeps the result line for a read and for an error", () => {
		const read = draw({ op: "list" }, "B2 [todo p2] second", { shown: 1, total: 1 });
		expect(read.result).toContain("1 item");
		expect(read.header).toBe("✓ Backlog(list)");
	});

	it("shows a duration from one second, not a fast call's milliseconds", () => {
		expect(draw({ op: "done", id: "B561" }, "x", { item }, 21).header).not.toMatch(/\d+ms/);
		expect(draw({ op: "done", id: "B561" }, "x", { item }, 999).header).not.toMatch(/999ms|1s/);
		expect(draw({ op: "done", id: "B561" }, "x", { item }, 2_300).header).toContain("2.3s");
	});
});
