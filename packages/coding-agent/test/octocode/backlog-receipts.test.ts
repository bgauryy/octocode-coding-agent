import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { evidenceIndicator } from "../../src/octocode/backlog/receipts.ts";
import type { QaRequest, QaReview } from "../../src/octocode/backlog/qa-gate.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { beginVerification, finishVerification, receiptId } from "../../src/octocode/files/bash/verification.ts";
import { recordMutation } from "../../src/octocode/files/feedback/revisions.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-receipts-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const SESSION = "session-test";
const READY = { goal: "Result can be checked", why: "Users need it" };
const DONE = { summary: "did it", verification: "passed: ran the check", files: ["src/a.ts"] };

/** A saved `bash` result as the session holds it: the receipt sits in `details.verification`. */
function bashEntry(code: number, command = "yarn test") {
	const receipt = finishVerification(beginVerification(command, "/repo", SESSION, Date.now()), {
		code,
		signal: null,
		seconds: 1,
	});
	return {
		receipt,
		entry: { type: "message", message: { role: "toolResult", toolName: "bash", details: { verification: receipt } } },
	};
}

function setup(qa = false) {
	const requests: QaRequest[] = [];
	let reply: QaReview = { skipped: "no small model" };
	const fake = fakeHost(qa ? { backlog: { qa: "all" } } : {});
	registerBacklog(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		...(qa
			? {
					review: async (request: QaRequest) => {
						requests.push(request);
						return reply;
					},
				}
			: {}),
	});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd, idle: false });
	const entries: unknown[] = [];
	ctx.sessionManager.getBranch = (() => entries) as never;
	const call = async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	const store = () => new BacklogStore(() => workspaceDb(cwd).agent, workspaceDb(cwd).workspace.id);
	const open = async () => {
		await call({ op: "add", items: [{ title: "Work", ...READY, state: "todo", priority: "p1", type: "feature" }] });
		await call({ op: "claim", id: "B1" });
	};
	return { call, store, open, entries, requests, answer: (next: QaReview) => (reply = next) };
}

describe("a completion that cites a shell receipt", () => {
	it("stores the receipt's facts and shows a recorded check when it is fresh and exited 0", async () => {
		const t = setup();
		await t.open();
		const { receipt, entry } = bashEntry(0);
		t.entries.push(entry);
		await t.call({ op: "done", id: "B1", completion: { ...DONE, receipt: receiptId(receipt) } });
		const done = t.store().get("B1")!.completions[0];
		expect(done.receipt).toMatchObject({ id: receiptId(receipt), command: "yarn test", exitCode: 0, stale: false });
		expect(evidenceIndicator(done)).toBe("Recorded check");
	});

	it("keeps a secret in the cited command off the board while the id still names the receipt", async () => {
		const t = setup();
		await t.open();
		const token = `ghp_${"a1B2".repeat(9)}`;
		const { receipt, entry } = bashEntry(0, `GH_TOKEN=${token} gh api user`);
		t.entries.push(entry);
		await t.call({ op: "done", id: "B1", completion: { ...DONE, receipt: receiptId(receipt) } });
		const done = t.store().get("B1")!.completions[0];
		expect(done.receipt?.id).toBe(receiptId(receipt));
		expect(done.receipt?.command).not.toContain(token);
		expect(done.receipt?.command).toContain("gh api user");
	});

	it("is Stale when a later edit moved the workspace past the receipt", async () => {
		const t = setup();
		await t.open();
		t.entries.push(bashEntry(0).entry);
		recordMutation(SESSION);
		await t.call({ op: "done", id: "B1", completion: { ...DONE, receipt: "latest" } });
		const done = t.store().get("B1")!.completions[0];
		expect(done.receipt?.stale).toBe(true);
		expect(evidenceIndicator(done)).toBe("Stale");
	});

	it("keeps a nonzero exit from reading as a recorded check", async () => {
		const t = setup();
		await t.open();
		t.entries.push(bashEntry(2).entry);
		await t.call({ op: "done", id: "B1", completion: { ...DONE, receipt: "latest" } });
		expect(evidenceIndicator(t.store().get("B1")!.completions[0])).toBe("Reported");
	});

	it("is refused when the id is not a receipt of this session", async () => {
		const t = setup();
		await t.open();
		t.entries.push(bashEntry(0).entry);
		await expect(
			t.call({ op: "done", id: "B1", completion: { ...DONE, receipt: "other-session:1:abc" } }),
		).rejects.toThrow(/not a receipt of this session/);
		expect(t.store().get("B1")?.state).toBe("ongoing");
	});

	it("is Reported without a receipt", async () => {
		const t = setup();
		await t.open();
		await t.call({ op: "done", id: "B1", completion: DONE });
		const done = t.store().get("B1")!.completions[0];
		expect(done.receipt).toBeUndefined();
		expect(evidenceIndicator(done)).toBe("Reported");
	});

	it("is Skipped when the QA review did not run, and a retry replays instead of conflicting", async () => {
		const t = setup(true);
		await t.open();
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(evidenceIndicator(t.store().get("B1")!.completions[0])).toBe("Skipped");
	});

	it("hands the reviewer the receipt's facts", async () => {
		const t = setup(true);
		await t.open();
		const { receipt, entry } = bashEntry(0);
		t.entries.push(entry);
		await t.call({ op: "done", id: "B1", completion: { ...DONE, receipt: receiptId(receipt) } });
		expect(t.requests[0].receipt).toMatchObject({ command: "yarn test", exitCode: 0, stale: false });
		expect(t.requests[0].verification).toContain("Recorded check");
	});

	it("replays a retry with the facts it was first written with", async () => {
		const t = setup();
		await t.open();
		t.entries.push(bashEntry(0).entry);
		const completion = { ...DONE, receipt: "latest", operationKey: "k1" };
		await t.call({ op: "done", id: "B1", completion });
		recordMutation(SESSION);
		await t.call({ op: "done", id: "B1", completion });
		expect(t.store().get("B1")!.completions).toHaveLength(1);
	});
});
