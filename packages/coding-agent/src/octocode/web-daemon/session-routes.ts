import type { IncomingMessage } from "node:http";
import { Value } from "typebox/value";
import { ApplicationCommandSchema, WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts";
import { WorkspaceCommandSchema } from "@octocodeai/octocode-contracts/protocol";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { redactData, redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { handleProfilerRequest } from "../profiler/route.ts";
import { handleApplicationDataRequest } from "../workspace/application-data.ts";
import type { AttachClient } from "./attach-client.ts";
import { readJsonBody } from "../shared/json-body.ts";
import type { Reply } from "./http-util.ts";

/**
 * Application and workspace commands for one attached session. The daemon only forwards them: validation of the shape
 * happens here, and authority (permissions, receipts, deduplication) stays in the session. Returns true when answered.
 */
export async function handleSessionRequest(
	req: IncomingMessage,
	url: URL,
	sessionId: string,
	client: AttachClient,
	reply: Reply,
	changed: () => void,
): Promise<boolean> {
	if (await handleApplicationDataRequest(req, url, client.application, sessionId, reply)) return true;
	try {
		if (await handleProfilerRequest(req, url, client.profiler, reply)) return true;
	} catch (error) {
		reply(409, { error: redactSecrets(errorMessage(error)) });
		return true;
	}
	if (url.pathname === WORKSPACE_ROUTES.application) {
		if (req.method === "GET") {
			reply(405, { error: "Use the application stream for state." });
			return true;
		}
		if (req.method !== "POST") return false;
		const input = await readJsonBody(req, reply);
		if (input === undefined) return true;
		if (!Value.Check(ApplicationCommandSchema, input)) {
			reply(400, { error: "Invalid application command" });
			return true;
		}
		if (input.sessionId !== sessionId) {
			reply(409, { error: "Session changed" });
			return true;
		}
		try {
			reply(200, { receipt: redactData(await client.application.execute(input)) });
		} catch (error) {
			reply(409, { error: redactSecrets(errorMessage(error)) });
		}
		return true;
	}
	if (url.pathname === WORKSPACE_ROUTES.workspace) {
		try {
			if (req.method === "GET") {
				reply(200, await client.workspace.snapshot());
				return true;
			}
			if (req.method !== "POST") return false;
			const input = await readJsonBody(req, reply);
			if (input === undefined) return true;
			if (!Value.Check(WorkspaceCommandSchema, input)) {
				reply(400, { error: "Invalid workspace command" });
				return true;
			}
			const receipt = await client.workspace.execute(input);
			reply(200, { receipt });
			changed();
		} catch (error) {
			reply(409, { error: redactSecrets(errorMessage(error)) });
		}
		return true;
	}
	return false;
}
