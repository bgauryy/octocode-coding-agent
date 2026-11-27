import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionChecker } from "../../src/octocode/timer/condition.ts";
import { decodeCondition, encodeCondition, parseUntil } from "../../src/octocode/timer/conditions/index.ts";
import type { ConditionDeps } from "../../src/octocode/timer/conditions/types.ts";
import { tmp } from "./helpers.ts";

let cwd: string;
beforeEach(() => {
	cwd = tmp();
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const deps = (reservation: ConditionDeps["reservation"]): ConditionDeps => ({
	reservation,
	context: () => undefined,
	item: () => undefined,
	blockers: () => undefined,
	agentEnd: () => undefined,
	watchDatabase: () => () => undefined,
	judge: async () => ({ verdict: "skipped", reason: "not used" }),
});

describe("deferred timer commands respect current reservations", () => {
	it("rechecks a reservation acquired between polls before changing its target", async () => {
		const target = path.join(cwd, "owned.txt");
		let held = false;
		const reservation = vi.fn((absolute: string) =>
			held && absolute === target ? "owned.txt is reserved by another agent" : undefined,
		);
		const check = conditionChecker(deps(reservation));
		const condition = { kind: "command" as const, command: "printf x >> owned.txt" };
		expect(await check(condition, cwd)).toMatchObject({ met: true, exit: 0 });
		expect(fs.readFileSync(target, "utf8")).toBe("x");
		held = true;
		const result = await check(condition, cwd);
		expect({ result, contents: fs.readFileSync(target, "utf8") }).toEqual({
			result: { met: false, exit: null, output: "", refused: "owned.txt is reserved by another agent" },
			contents: "x",
		});
		expect(reservation).toHaveBeenCalledWith(target, "owned.txt");
		held = false;
		expect(await check(condition, cwd)).toMatchObject({ met: true, exit: 0 });
		expect(fs.readFileSync(target, "utf8")).toBe("xx");
	});

	it.each([false, true])("refuses a restored command before execution (judged trigger: %s)", async (judged) => {
		const original = parseUntil({
			command: "printf restored > owned.txt",
			...(judged ? { check: "Did the fixture finish?" } : {}),
		})!;
		const restored = decodeCondition(original.kind, encodeCondition(original))!;
		const judge = vi.fn(deps(() => undefined).judge);
		const check = conditionChecker({ ...deps(() => "reserved after scheduling"), judge });
		const result = await check(restored, {
			cwd,
			row: { id: 1, checks: 0, spentUsd: 0, sessionId: "isolated-timer" },
		});
		expect(result).toEqual({ met: false, exit: null, output: "", refused: "reserved after scheduling" });
		expect(fs.existsSync(path.join(cwd, "owned.txt"))).toBe(false);
		expect(judge).not.toHaveBeenCalled();
	});

	it("allows a reader of a reserved path and writes to an unreserved path", async () => {
		fs.writeFileSync(path.join(cwd, "owned.txt"), "unchanged");
		const check = conditionChecker(
			deps((absolute) => (absolute === path.join(cwd, "owned.txt") ? "reserved" : undefined)),
		);
		expect(await check({ kind: "command", command: "cat owned.txt" }, cwd)).toMatchObject({
			met: true,
			exit: 0,
			output: "unchanged",
		});
		expect(await check({ kind: "command", command: "printf free > free.txt" }, cwd)).toMatchObject({ met: true });
		expect(fs.readFileSync(path.join(cwd, "free.txt"), "utf8")).toBe("free");
	});

	it("does not start a cancelled check", async () => {
		const reservation = vi.fn(() => undefined);
		const check = conditionChecker(deps(reservation));
		await expect(
			check(
				{ kind: "command", command: "printf x > owned.txt" },
				{
					cwd,
					signal: AbortSignal.abort(new Error("cancelled")),
				},
			),
		).rejects.toThrow("cancelled");
		expect(fs.existsSync(path.join(cwd, "owned.txt"))).toBe(false);
		expect(reservation).not.toHaveBeenCalled();
	});
});
