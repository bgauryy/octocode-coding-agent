import type { IncomingMessage } from "node:http";
import { Value } from "typebox/value";
import {
	TERMINAL_COMMAND_ROUTE,
	TerminalCommandRequestSchema,
	type TerminalCommandRequest,
} from "@octocodeai/octocode-contracts/protocol";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { getApplicationPortForSession } from "../../core/application/registry.ts";
import { readJsonBody } from "../shared/json-body.ts";

export function sessionCommand(sessionId: string, request: TerminalCommandRequest) {
	const commands = getApplicationPortForSession(sessionId)?.terminalCommands;
	if (!commands) throw new Error("Open /web from an interactive terminal session to use its commands.");
	return commands(request);
}

/** Both local servers authenticate before routing here. Published links have no access to terminal commands or their output. */
export async function handleTerminalCommands(
	req: IncomingMessage,
	url: URL,
	local: boolean,
	run: (request: TerminalCommandRequest) => unknown,
	reply: (status: number, body: unknown) => void,
): Promise<boolean> {
	if (url.pathname !== TERMINAL_COMMAND_ROUTE) return false;
	if (!local) reply(403, { error: "Open the local /web link to use terminal commands." });
	else if (req.method !== "GET" && req.method !== "POST") reply(405, { error: "Method not allowed" });
	else {
		const request = req.method === "GET" ? { action: "list" } : await readJsonBody(req, reply);
		if (request === undefined) return true;
		if (!Value.Check(TerminalCommandRequestSchema, request)) reply(400, { error: "Invalid terminal command request" });
		else {
			try {
				reply(200, await run(request));
			} catch (error) {
				reply(409, { error: redactSecrets(errorMessage(error)).slice(0, 1000) });
			}
		}
	}
	return true;
}
