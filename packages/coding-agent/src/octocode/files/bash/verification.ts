import fs from "node:fs";
import type { JsonObject } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { currentMutationRevision, mutationEpoch } from "../feedback/revisions.ts";
import type { BashJob, JobExit, VerificationReceipt } from "../bash-jobs/types.ts";
import type { BashDetails } from "../render.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** Public tool schema for the receipt's stable, JSON-only fields. */
export const verificationSchema = Type.Object({
	command: Type.String(),
	cwd: Type.String(),
	sessionId: Type.String(),
	mutationEpoch: Type.String(),
	startedAt: Type.Number(),
	completedAt: Type.Optional(Type.Number()),
	state: Type.Union([
		Type.Literal("running"),
		Type.Literal("finished"),
		Type.Literal("failed"),
		Type.Literal("stopped"),
	]),
	exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	elapsedSeconds: Type.Optional(Type.Number()),
	output: Type.Object({
		complete: Type.Boolean(),
		log: Type.Optional(Type.String()),
		logAvailable: Type.Optional(Type.Boolean()),
		archiveAvailable: Type.Optional(Type.Boolean()),
		tailIncomplete: Type.Optional(Type.Boolean()),
		rotations: Type.Optional(Type.Number()),
	}),
	revisionAtLaunch: Type.Number(),
	revisionAtCompletion: Type.Optional(Type.Number()),
	stale: Type.Boolean(),
});

export function beginVerification(
	command: string,
	cwd: string,
	sessionId: string,
	startedAt = Date.now(),
): VerificationReceipt {
	return {
		command,
		cwd,
		sessionId,
		mutationEpoch,
		startedAt,
		state: "running",
		output: { complete: false },
		revisionAtLaunch: currentMutationRevision(sessionId),
		stale: false,
	};
}

function readableLog(file: string): boolean {
	try {
		const handle = fs.openSync(file, "r");
		fs.closeSync(handle);
		return true;
	} catch {
		return false;
	}
}

/** Shutdown reports before a process stops or its pipes drain, so there is no terminal evidence yet. */
export function pendingVerification(receipt: VerificationReceipt, job: BashJob): VerificationReceipt {
	return {
		...receipt,
		state: "running",
		output: { complete: false, log: job.log, logAvailable: readableLog(job.log), tailIncomplete: true },
		stale:
			receipt.mutationEpoch !== mutationEpoch ||
			currentMutationRevision(receipt.sessionId) !== receipt.revisionAtLaunch,
	};
}

export function finishVerification(
	receipt: VerificationReceipt,
	{ code, signal, seconds, logStopped, logRotations }: JobExit,
	job?: BashJob,
): VerificationReceipt {
	const revisionAtCompletion = currentMutationRevision(receipt.sessionId);
	let logAvailable = job ? readableLog(job.log) : undefined;
	const archiveAvailable = job && logRotations === 1 ? readableLog(`${job.log}.1`) : undefined;
	let tailIncomplete = (logRotations ?? 0) > 0;
	if (job && logAvailable) {
		try {
			const size = fs.statSync(job.log).size;
			if (size > 4 * 1024) tailIncomplete = true;
			else tailIncomplete ||= fs.readFileSync(job.log, "utf8").split("\n").length > 41;
		} catch {
			logAvailable = false;
		}
	}
	const state = job?.stopped ? "stopped" : code === 0 && !signal ? "finished" : "failed";
	const stale = receipt.mutationEpoch !== mutationEpoch || revisionAtCompletion !== receipt.revisionAtLaunch;
	return {
		...receipt,
		completedAt: Date.now(),
		state,
		exitCode: code,
		signal,
		elapsedSeconds: seconds,
		output: {
			complete: job
				? !!logAvailable && !logStopped && (logRotations ?? 0) <= 1 && (logRotations !== 1 || archiveAvailable === true)
				: receipt.output.complete,
			...(job ? { log: job.log, logAvailable, tailIncomplete } : {}),
			...(archiveAvailable !== undefined ? { archiveAvailable } : {}),
			...(logRotations ? { rotations: logRotations } : {}),
		},
		revisionAtCompletion,
		stale,
	};
}

export function verificationLine(receipt: VerificationReceipt): string {
	const differentProcess = receipt.mutationEpoch !== mutationEpoch;
	const laterEdit = currentMutationRevision(receipt.sessionId) !== receipt.revisionAtLaunch;
	const outcome =
		receipt.state === "running"
			? "no result yet"
			: receipt.state === "finished"
				? "command exited 0"
				: receipt.signal
					? `ended by ${receipt.signal}`
					: receipt.exitCode !== null && receipt.exitCode !== undefined
						? `exit ${receipt.exitCode}`
						: receipt.state;
	const revision =
		`mutation revision ${receipt.revisionAtLaunch}` +
		(receipt.revisionAtCompletion !== undefined ? ` → ${receipt.revisionAtCompletion}` : "");
	return `Verification: ${outcome}; ${revision}${differentProcess ? "; process changed; this check cannot validate the current state" : laterEdit || receipt.stale ? "; later agent edits invalidate this check for the current state" : ""}${receipt.output.tailIncomplete ? "; output tail incomplete; inspect full log" : ""}${receipt.output.complete || (receipt.state === "running" && !receipt.output.tailIncomplete) ? "" : "; full output incomplete or unavailable"}`;
}

/** Serialize an immutable snapshot for tool result contracts; later job completion creates a new receipt. */
export function verificationJson(receipt: VerificationReceipt): JsonObject {
	return JSON.parse(
		JSON.stringify({
			...receipt,
			stale:
				receipt.stale ||
				receipt.mutationEpoch !== mutationEpoch ||
				currentMutationRevision(receipt.sessionId) !== receipt.revisionAtLaunch,
		}),
	) as JsonObject;
}

/** The receipt of a foreground command that returned: its exit from the tool's structured `output`, and where its full output went. */
export function foregroundReceipt(
	verification: VerificationReceipt,
	endedBy: NodeJS.Signals | null,
	output: unknown,
	details: BashDetails,
): VerificationReceipt {
	verification.output.complete = !details.truncation || !!details.fullOutputPath;
	const receipt = finishVerification(verification, {
		code: isRecord(output) && typeof output.exit_code === "number" ? output.exit_code : null,
		signal: endedBy,
		seconds:
			isRecord(output) && typeof output.wall_time_seconds === "number"
				? output.wall_time_seconds
				: (Date.now() - verification.startedAt) / 1000,
	});
	receipt.output.log = details.fullOutputPath;
	receipt.output.logAvailable = details.fullOutputPath ? readableLog(details.fullOutputPath) : undefined;
	receipt.output.complete &&= !details.fullOutputPath || receipt.output.logAvailable === true;
	return receipt;
}
