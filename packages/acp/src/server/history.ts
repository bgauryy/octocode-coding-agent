import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { RequestError, methods, type AgentContext } from "@agentclientprotocol/sdk";
import { ENV_SESSION_DIR } from "../../../coding-agent/src/config.ts";
import { SessionManager, type SessionInfo } from "../../../coding-agent/src/core/session-manager.ts";
import { createCustomMessage } from "../../../coding-agent/src/core/messages.ts";
import { SettingsManager } from "../../../coding-agent/src/core/settings-manager.ts";
import { normalizePath } from "../../../common/src/paths.ts";
import { compactionReplay, customMessageUpdates, toolContent, toolTitle } from "./events.ts";

function sessionDir(cwd: string, override?: string): string | undefined {
	const fromEnvironment = process.env[ENV_SESSION_DIR];
	const chosen = override ?? fromEnvironment ?? SettingsManager.createForStartup(cwd).getSessionDir();
	return chosen ? resolve(cwd, normalizePath(chosen)) : undefined;
}

/** Resolve an ACP identity through the owning transcript index, never a client path. */
export async function findHistory(id: string, cwd: string, configuredDir?: string): Promise<SessionInfo> {
	const directory = await canonicalDirectory(cwd);
	const sessions = await SessionManager.list(directory, sessionDir(directory, configuredDir));
	const info = sessions.find((item) => item.id === id && item.cwd && isAbsolute(item.cwd));
	if (!info || (await realpath(info.cwd).catch(() => undefined)) !== directory) throw RequestError.resourceNotFound(id);
	return info;
}

export async function canonicalDirectory(cwd: string): Promise<string> {
	if (!isAbsolute(cwd)) throw RequestError.invalidParams(undefined, "Session cwd must be an absolute directory.");
	try {
		const { stat } = await import("node:fs/promises");
		const directory = await realpath(cwd);
		if ((await stat(directory)).isDirectory()) return directory;
	} catch {
		// Invalid and missing directories share the same protocol error.
	}
	throw RequestError.invalidParams(undefined, "Session cwd must name an existing directory.");
}

/** Snapshot history before startup hooks run; replay it before releasing the worker's live updates. */
export function prepareHistoryReplay(path: string, id: string, client: AgentContext): () => Promise<void> {
	const manager = SessionManager.open(path);
	if (manager.getSessionId() !== id) throw RequestError.resourceNotFound(id);
	const branch = manager.getBranch();
	return async () => {
		const tools = new Set<string>();
		for (const entry of branch) {
			if (entry.type === "compaction") {
				for (const update of compactionReplay(entry.id, entry.summary, entry.tokensBefore))
					await client.notify(methods.client.session.update, { sessionId: id, update });
				continue;
			}
			const message =
				entry.type === "message"
					? entry.message
					: entry.type === "custom_message" && entry.display
						? createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp)
						: undefined;
			if (!message) continue;
			if (message.role === "toolResult") {
				if (!tools.has(message.toolCallId)) {
					await client.notify(methods.client.session.update, {
						sessionId: id,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: message.toolCallId,
							title: message.toolName.slice(0, 512),
							status: "in_progress",
						},
					});
				}
				await client.notify(methods.client.session.update, {
					sessionId: id,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: message.toolCallId,
						status: message.isError ? "failed" : "completed",
						content: toolContent(message),
					},
				});
				continue;
			}
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") continue;
			if (message.role === "custom") {
				if (!message.display) continue;
				for (const update of customMessageUpdates(message))
					await client.notify(methods.client.session.update, { sessionId: id, update });
				continue;
			}
			const blocks =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			for (const block of blocks) {
				if (block.type === "toolCall" && "id" in block && "name" in block && message.role === "assistant") {
					tools.add(block.id);
					await client.notify(methods.client.session.update, {
						sessionId: id,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: block.id,
							title: toolTitle(block.name, block.arguments),
							status: "in_progress",
						},
					});
					continue;
				}
				if (block.type !== "text" && block.type !== "image") continue;
				if (block.type === "text" && !block.text) continue;
				await client.notify(methods.client.session.update, {
					sessionId: id,
					update: {
						sessionUpdate: message.role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
						content:
							block.type === "text"
								? { type: "text", text: block.text }
								: { type: "image", data: block.data, mimeType: block.mimeType },
					},
				});
			}
		}
	};
}

export async function listHistory(cwd?: string, cursor?: string, configuredDir?: string) {
	const directory = cwd === undefined ? undefined : await canonicalDirectory(cwd);
	let offset = 0;
	if (cursor !== undefined) {
		try {
			const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			if (!parsed || typeof parsed !== "object" || !("cwd" in parsed) || !("offset" in parsed))
				throw new Error("Invalid cursor");
			if (parsed.cwd !== (directory ?? null) || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0)
				throw new Error("Invalid cursor");
			offset = parsed.offset as number;
		} catch {
			throw RequestError.invalidParams(undefined, "Invalid session list cursor.");
		}
	}
	const all = directory
		? await SessionManager.list(directory, sessionDir(directory, configuredDir))
		: await SessionManager.listAll(sessionDir(process.cwd(), configuredDir));
	const matching = (
		await Promise.all(
			all.map(async (entry) =>
				entry.cwd &&
				isAbsolute(entry.cwd) &&
				(!directory || (await realpath(entry.cwd).catch(() => undefined)) === directory)
					? entry
					: undefined,
			),
		)
	).filter((entry): entry is SessionInfo => entry !== undefined);
	const page = matching.slice(offset, offset + 50);
	return {
		sessions: page.map((entry) => ({
			sessionId: entry.id,
			cwd: entry.cwd,
			...(entry.name || entry.firstMessage ? { title: entry.name ?? entry.firstMessage.slice(0, 120) } : {}),
			updatedAt: entry.modified.toISOString(),
		})),
		...(matching.length > offset + page.length
			? {
					nextCursor: Buffer.from(JSON.stringify({ cwd: directory ?? null, offset: offset + page.length })).toString(
						"base64url",
					),
				}
			: {}),
	};
}
