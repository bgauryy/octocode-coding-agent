import fs from "node:fs";
import path from "node:path";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import type { ResultDetails } from "./run-types.ts";

const VERSION_FILE = /^report-([a-f0-9]{64})\.md$/;

/**
 * The whole text of a finished child's report for the transcript: the saved version `details.reportArtifact` names, which
 * holds what the message content (cut to the model's head) leaves out. Undefined when the report was short enough to
 * travel whole, carries a structured result (the host's verdict is drawn instead), or its file is gone or no longer
 * matches its hash, so the caller draws the content.
 */
export function fullReportText(details: Partial<ResultDetails>): string | undefined {
	const artifact = details.reportArtifact;
	if (!artifact?.path || details.structured) return undefined;
	if (VERSION_FILE.exec(path.basename(artifact.path))?.[1] !== artifact.sha256) return undefined;
	let bytes: Buffer;
	try {
		if (!fs.lstatSync(artifact.path).isFile()) return undefined;
		bytes = fs.readFileSync(artifact.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return sha256(bytes) === artifact.sha256 ? bytes.toString("utf8") : undefined;
}
