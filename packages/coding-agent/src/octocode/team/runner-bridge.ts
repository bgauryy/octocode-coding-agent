import { serveTools } from "../../../../mcp/src/api.ts";
import { RunnerMember, type RunnerMemberInput } from "./runner-member.ts";
import { callRunnerTeam, runnerTeamTool } from "./runner-tools.ts";
import type { SendHost } from "./session/send.ts";
import { renderPrompt } from "../../core/prompt-template.ts";

/** One authenticated server and member for one external turn, never a catalog of ambient tools. */
export async function openRunnerBridge(
	host: SendHost,
	input: RunnerMemberInput,
	vouch: (id: string, secret: string) => () => void,
) {
	const member = new RunnerMember(host, input, vouch);
	try {
		const server = await serveTools({
			name: "octocode-team",
			version: "1.0.0",
			tools: () => [runnerTeamTool],
			call: (call) => callRunnerTeam(member, call),
			instructions: renderPrompt("tools/agent/runner-server.md"),
		});
		let closing: Promise<void> | undefined;
		return {
			communication: {
				name: "octocode-team",
				url: server.url,
				headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
			},
			close: () =>
				(closing ??= (async () => {
					try {
						await server.close();
					} finally {
						member.close();
					}
				})()),
		};
	} catch (error) {
		member.close();
		throw error;
	}
}
