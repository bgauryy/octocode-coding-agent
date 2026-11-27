import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpWorkerClient } from "../host.ts";

/**
 * Tells the client which slash commands a prompt can run here (native commands, prompt templates and skills), as
 * `available_commands_update`. Built-in terminal commands are not among them: a prompt cannot run those. A worker that
 * cannot say leaves the client without the list, and the commands still work.
 */
export async function advertiseCommands(
	worker: Pick<AcpWorkerClient, "getCommands">,
	send: (update: SessionNotification["update"]) => void,
): Promise<void> {
	const commands = await worker.getCommands().catch(() => []);
	if (commands.length === 0) return;
	send({
		sessionUpdate: "available_commands_update",
		availableCommands: commands.map((command) => ({
			name: command.name,
			description: command.description ?? command.name,
			...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}),
		})),
	});
}
