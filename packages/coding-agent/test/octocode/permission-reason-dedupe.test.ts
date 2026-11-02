// A shell approval card names "why it asks" once, however many file targets are unresolved. Observed: a card for a
// `cd` followed by `cat` of 7 files repeated the line 7 times. The real source policy lists read targets only when the
// user has permission rules, so this drives checkPermission with a source decision built from the real Bash parser's
// targets for that command shape.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPermission, type CheckHost } from "../../src/octocode/permission/ask/check.ts";
import { bashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { systemLines } from "../../src/octocode/permission/effect.ts";
import type { PermissionRequest } from "../../src/octocode/permission/request.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const REASON = "Bash file target cannot be resolved before execution";

async function askFor(command: string) {
	await shellParserReady();
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const targets = bashSyntax(command).targets.map((target) => ({ ...target, allowed: false }));
	const shown: PermissionRequest[] = [];
	const host: CheckHost = {
		mode: () => "workspace",
		policy: () => new AbortController(),
		answeredSourceAsks: () => new WeakSet(),
		resolver: () => undefined,
		prepareUpdates: () => undefined,
		spawnGrants: new Set(),
		kinds: new Set(),
		grants: new Map(),
		snapshotMs: undefined,
		relay: false,
		isSubagent: false,
		select: async (_ctx, request) => {
			shown.push(request);
			return "once";
		},
		replacementSourceDecision: () => ({ decision: "none", shellTargets: targets }) as never,
		decided: (_request, verdict) => verdict,
	};
	const invocation = { active: true, toolCallId: "t1", toolName: "bash", input: { command } } as never;
	const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects: [] } });
	const verdict = await checkPermission(host, ctx, {
		invocation,
		action: "shell",
		title: "Run this command?",
		what: [command],
		cwd,
	});
	return { verdict, shown, uncertain: targets.filter((target) => target.uncertain).length };
}

const count = (text: string) => text.split(REASON).length - 1;

describe("shell approval reason lines", () => {
	it("names an unresolved-target reason once however many targets are unresolved", async () => {
		const { shown, uncertain } = await askFor("cd sub && cat -n a.md b.md c.md d.md");
		// Setup guards: the parser marks every target uncertain and the workspace mode asks.
		expect(uncertain).toBe(4);
		expect(shown).toHaveLength(1);
		const lines = systemLines(shown[0], "workspace").filter((line) => line.includes(REASON));
		// The reason is still shown, and the machine-readable reason list is unchanged.
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(shown[0].reasons?.filter((reason) => reason === "shell.target")).toHaveLength(1);
		// The card repeats nothing.
		expect(count(shown[0].reason ?? "")).toBe(1);
		expect(lines).toHaveLength(1);
	});

	it("still names the reason for a single unresolved target", async () => {
		const { shown, uncertain } = await askFor("cd sub && cat a.md");
		expect(uncertain).toBe(1);
		expect(shown).toHaveLength(1);
		expect(systemLines(shown[0], "workspace").filter((line) => line.includes(REASON))).toHaveLength(1);
	});

	it("does not ask about a fully resolved absolute read", async () => {
		const { shown, uncertain } = await askFor("cat /etc/hosts-not-a-real-file-for-f5");
		expect(uncertain).toBe(0);
		for (const request of shown) expect(count(request.reason ?? "")).toBe(0);
	});
});
