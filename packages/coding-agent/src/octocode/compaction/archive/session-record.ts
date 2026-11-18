import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { forks } from "../../../../../db/src/api.ts";
import { sharedAgentDb } from "../../../storage/database.ts";
import { readWorkspaceIdentity } from "../../../storage/workspace.ts";
import type { FeatureContext } from "../../../core/features/index.ts";
import type { RecordMessage, SessionRecord } from "../../history/archive/record.ts";
import { registeredWorkspace } from "../../../storage/workspace-database.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";

/** Ancestry is recorded when the host forks. Header paths supplied by imported and historical files are never opened here. */
export function forkLineage(
	sessions: Pick<FeatureContext["sessionManager"], "getSessionId" | "getSessionFile" | "getCwd">,
): string[] {
	const file = sessions.getSessionFile();
	if (!file) return [];
	try {
		const workspace = readWorkspaceIdentity(sessions.getCwd());
		if (!workspace) return [];
		const agent = sharedAgentDb();
		registeredWorkspace(workspace.root, agent);
		return forks.lineage(agent.db, agent.mirror.db, sessions.getSessionId(), canonicalPath(file), workspace.id);
	} catch {
		return [];
	}
}

/** A message's text, without thinking, tool calls or images. */
const messageText = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.flatMap((part) =>
						isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
					)
					.join("\n\n")
			: "";

/**
 * The current session's record (`history/archive.ts`) from its branch: its first user message is its goal, its last user
 * message and the replies after it its ending (their text; their tool calls are counted). Undefined when the session is
 * not saved (`--no-session`: nothing outlives it) or has no user message yet.
 */
export function sessionRecordOf(
	sessions: FeatureContext["sessionManager"],
	lineage: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): SessionRecord | undefined {
	const transcript = sessions.getSessionFile();
	if (!transcript) return undefined;
	const messages = sessions.getBranch().flatMap((entry) => {
		const message: unknown = entry.type === "message" ? entry.message : undefined;
		return isRecord(message) ? [{ message, at: entry.timestamp }] : [];
	});
	const users = messages.flatMap((entry, index) =>
		entry.message.role === "user" && messageText(entry.message.content).trim() ? [index] : [],
	);
	if (users.length === 0) return undefined;
	const toRecord = ({ message, at }: (typeof messages)[number]): RecordMessage => ({
		role: String(message.role),
		at,
		text: messageText(message.content),
	});
	const tail = messages.slice(users.at(-1));
	const ending = tail
		.filter(
			(entry, index) =>
				index === 0 || (entry.message.role === "assistant" && messageText(entry.message.content).trim()),
		)
		.map(toRecord);
	const toolCalls = tail.reduce(
		(sum, { message }) =>
			sum +
			(Array.isArray(message.content)
				? message.content.filter((part) => isRecord(part) && part.type === "toolCall").length
				: 0),
		0,
	);
	const cwd = sessions.getCwd();
	const parent = env[PARENT_SESSION_ENV]?.trim();
	const name = sessions.getSessionName();
	const started = sessions.getHeader()?.timestamp;
	const lastActive = sessions.getBranch().at(-1)?.timestamp;
	return {
		session: sessions.getSessionId(),
		repository: registeredWorkspace(cwd).id,
		workspace: cwd,
		...(lineage[0] ? { forkedFrom: lineage[0] } : {}),
		...(parent ? { parent } : {}),
		...(name ? { name } : {}),
		...(started ? { started } : {}),
		...(lastActive ? { lastActive } : {}),
		transcript,
		goal: toRecord(messages[users[0]]),
		ending,
		toolCalls,
	};
}
