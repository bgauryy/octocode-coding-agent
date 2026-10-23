import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beginVerification, finishVerification, verificationLine } from "../../src/octocode/files/bash/verification.ts";
import { mutationEpoch, recordMutation } from "../../src/octocode/files/feedback/revisions.ts";
import { jobReport } from "../../src/octocode/files/bash-jobs.ts";
import { tmp } from "./helpers.ts";

describe("verification receipts", () => {
	it("keeps handoff running, then distinguishes signal from a successful exit", () => {
		const receipt = beginVerification("check", "/repo", "signal-session");
		expect(receipt.mutationEpoch).toBe(mutationEpoch);
		expect(verificationLine(receipt)).toContain("running; no result yet");
		const ended = finishVerification(receipt, { code: null, signal: "SIGTERM", seconds: 2 });
		expect(ended).toMatchObject({ state: "failed", exitCode: null, signal: "SIGTERM", stale: false });
		expect(verificationLine(ended)).toContain("ended by SIGTERM");
	});

	it("rejects a receipt from a different process epoch even with matching revision", () => {
		const receipt = beginVerification("tests", "/repo", "epoch-session");
		const old = { ...receipt, mutationEpoch: "old-process" };
		const ended = finishVerification(old, { code: 0, signal: null, seconds: 1 });
		expect(ended.stale).toBe(true);
		expect(verificationLine(old)).toContain("process changed; this check cannot validate the current state");
	});

	it("reports unavailable and rotated output separately from process success", () => {
		const cwd = tmp();
		const log = path.join(cwd, "missing.log");
		const receipt = beginVerification("build", cwd, "rotated-session");
		const job = {
			id: "bash-7",
			command: "build",
			cwd,
			log,
			pid: 1,
			startedAt: receipt.startedAt,
			verification: receipt,
			done: Promise.resolve({ code: 0, signal: null, seconds: 1 }),
		};
		job.verification = finishVerification(receipt, { code: 0, signal: null, seconds: 1, logRotations: 2 }, job);
		expect(job.verification).toMatchObject({
			state: "finished",
			output: { complete: false, logAvailable: false, rotations: 2 },
		});
		expect(jobReport(job, { code: 0, signal: null, seconds: 1, logRotations: 2 })).toContain("Log unavailable");
		fs.writeFileSync(log, "tail");
		const withLog = finishVerification(receipt, { code: 0, signal: null, seconds: 1, logRotations: 2 }, job);
		expect(withLog.output).toMatchObject({ complete: false, logAvailable: true, tailIncomplete: true });
		const missingArchive = finishVerification(receipt, { code: 0, signal: null, seconds: 1, logRotations: 1 }, job);
		expect(missingArchive.output).toMatchObject({ complete: false, archiveAvailable: false });
		job.verification = missingArchive;
		expect(jobReport(job, { code: 0, signal: null, seconds: 1, logRotations: 1 })).toContain(
			"is unavailable; earlier output cannot be recovered",
		);
		fs.writeFileSync(`${log}.1`, "earlier\n");
		const archived = finishVerification(receipt, { code: 0, signal: null, seconds: 1, logRotations: 1 }, job);
		expect(archived.output).toMatchObject({ complete: true, archiveAvailable: true, tailIncomplete: true });
		fs.writeFileSync(log, Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"));
		const longTail = finishVerification(receipt, { code: 0, signal: null, seconds: 1 }, job);
		expect(longTail.output).toMatchObject({ complete: true, logAvailable: true, tailIncomplete: true });
		expect(verificationLine(longTail)).toContain("output tail incomplete; inspect full log");
	});

	it("invalidates evidence if a file tool commit happens after launch", () => {
		const receipt = beginVerification("tests", "/repo", "later-edit-session");
		recordMutation("later-edit-session");
		const ended = finishVerification(receipt, { code: 0, signal: null, seconds: 1 });
		expect(ended).toMatchObject({ state: "finished", stale: true });
		expect(verificationLine(ended)).toContain("later agent edits invalidate this check");
	});

	it("re-evaluates an older receipt after a subsequent edit", () => {
		const receipt = beginVerification("tests", "/repo", "after-completion-session");
		const ended = finishVerification(receipt, { code: 0, signal: null, seconds: 1 });
		expect(ended.stale).toBe(false);
		recordMutation("after-completion-session");
		expect(verificationLine(ended)).toContain("later agent edits invalidate this check");
	});
});
