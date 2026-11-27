import type { IncomingMessage } from "node:http";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { EvidenceReadSchema, parseAnchor } from "@octocodeai/octocode-contracts/evidence";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { redactData, redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { Value } from "typebox/value";
import { readEvidence } from "../archive/evidence.ts";

type Reply = (status: number, body: unknown) => void;
/** Reads one anchor string (and the cursor of the previous page) as the session that owns it resolves it. */
export type EvidenceReader = (anchor: string, cursor?: string) => Promise<unknown>;

/** The reader of a session running in this process, scoped to the history of `cwd`. */
export const localEvidence =
	(cwd: string): EvidenceReader =>
	async (anchor, cursor) => {
		const parsed = parseAnchor(anchor);
		if (!parsed) throw new Error("Not a source anchor.");
		return readEvidence(cwd, parsed, { cursor });
	};

/**
 * `GET WORKSPACE_ROUTES.evidence?sessionId=&anchor=[&cursor=]`: one bounded, redacted `EvidenceRead` for the daemon and
 * the single-session server alike. Called only after the loopback host, origin and token checks, so a read-only view
 * token may read. Returns true when the path is this route.
 */
export async function handleEvidenceRequest(
	req: IncomingMessage,
	url: URL,
	read: EvidenceReader,
	sessionId: string,
	reply: Reply,
): Promise<boolean> {
	if (url.pathname !== WORKSPACE_ROUTES.evidence) return false;
	if (req.method !== "GET") {
		reply(405, { error: "Evidence is read with GET" });
		return true;
	}
	if (url.searchParams.get("sessionId") !== sessionId) {
		reply(409, { error: "Session changed" });
		return true;
	}
	const anchor = url.searchParams.get("anchor") ?? "";
	const cursor = url.searchParams.get("cursor") ?? undefined;
	if (!parseAnchor(anchor)) {
		reply(400, { error: "anchor must look like archive:<session>/<segment>/<entry> or transcript:<session>/<entry>" });
		return true;
	}
	try {
		const evidence = await read(anchor, cursor);
		if (!Value.Check(EvidenceReadSchema, evidence)) throw new Error("The session returned an invalid evidence read.");
		reply(200, redactData(evidence));
	} catch (error) {
		reply(400, { error: redactSecrets(errorMessage(error)).slice(0, 500) });
	}
	return true;
}
