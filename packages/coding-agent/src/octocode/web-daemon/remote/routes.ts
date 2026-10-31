import type { IncomingMessage } from "node:http";
import { Value } from "typebox/value";
import { RemotePublishSchema, RemoteStatusSchema } from "@octocodeai/octocode-contracts/daemon";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { redactSecrets } from "../../shared/sanitize.ts";
import { readJsonBody, type Reply } from "../http-util.ts";
import type { RemotePublisher } from "./publisher.ts";

/**
 * `/api/admin/remote` for the launch token only (the server refuses every other token on admin routes): GET the
 * publication status (fingerprints, never capabilities), POST one link to publish (the only reply that carries it),
 * DELETE to stop publishing and replace the remote control and view tokens. Returns true when answered.
 */
export async function handleRemoteRequest(
	req: IncomingMessage,
	reply: Reply,
	publisher: RemotePublisher,
): Promise<boolean> {
	if (req.method === "GET") {
		const status = publisher.status();
		if (!Value.Check(RemoteStatusSchema, status)) {
			reply(500, { error: "Remote status is invalid" });
			return true;
		}
		reply(200, status);
		return true;
	}
	if (req.method === "DELETE") {
		publisher.stop();
		reply(200, { stopped: true });
		return true;
	}
	if (req.method !== "POST") return false;
	const input = await readJsonBody(req, reply);
	if (input === undefined) return true;
	if (!Value.Check(RemotePublishSchema, input)) {
		reply(400, { error: "Invalid remote publication request" });
		return true;
	}
	try {
		const link = publisher.publish(input);
		reply(200, { link });
	} catch (error) {
		reply(409, { error: redactSecrets(errorMessage(error)).slice(0, 500) });
	}
	return true;
}
