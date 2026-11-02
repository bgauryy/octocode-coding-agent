import {
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { parseArgs } from "../../../src/cli/args.ts";
import type { AgentSessionEvent } from "../../../src/core/agent-session/types.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../../src/core/compaction/utils.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ChildIdentity } from "../../../src/octocode/instructions/task.ts";
import { withIdentity } from "../../../src/octocode/instructions/task.ts";
import { assignmentText } from "../../../src/octocode/subagents/identity-reminder.ts";
import { type Identity, subagentProcessEnv } from "../../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../../src/octocode/subagents/process/session.ts";
import { loadProfiles } from "../../../src/octocode/subagents/profiles.ts";
import type { ResultContract } from "../../../src/octocode/subagents/result-schema.ts";
import { childTaskInput } from "../../../src/octocode/subagents/task-text.ts";
import { baseEnv, type Fixture, scriptedSession, withEnv } from "./capture.ts";

/**
 * One child process's turns in a real session on a scripted model, started as `subagents/tool.ts` starts it (environment
 * from `subagentProcessEnv`, tools from `buildAgentArgs`, task from `childTaskInput` and `withIdentity`, assignment from
 * `assignmentText`), saved where `--session-dir` puts it. A task resume reopens that file with the new assignment, as a
 * new child process does.
 */

/** Octocode's cache-sharing summary request (`shared-summary.ts`); the standalone ones send `SUMMARIZATION_SYSTEM_PROMPT`. */
const SUMMARY_REQUEST = "write a context checkpoint";
/** A provider's context-overflow error, as `isContextOverflow` recognizes it (Anthropic's wording). */
const OVERFLOW = "prompt is too long: 213462 tokens > 200000 maximum";

/** What one provider-bound request held: its system message and tools (serialized) and its conversation texts. */
export interface Request {
	system: string;
	tools: string;
	texts: string[];
	summary: boolean;
}

export function messageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content)
		? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("")
		: String(content ?? "");
}

/** The parent's side of one run: the assignment as `tool.ts` renders it, and the task it sends. */
export function assign(
	identity: Identity,
	task: string,
	resultContract?: ResultContract,
): { identity: Identity; assigned: ChildIdentity; task: string } {
	const parts = { referenced: "", browserMode: undefined, skillText: "", resultContract };
	const assigned = { ...identity };
	return {
		identity: { ...identity, assignment: assignmentText(assigned, undefined, parts, false) },
		assigned,
		task: withIdentity(childTaskInput(task, parts), assigned),
	};
}

type ChildSession = Awaited<ReturnType<typeof scriptedSession>>["session"];

/** A prompt and the model's reply; `overflow`: its first request fails with a context overflow instead. */
export type Step = { prompt: string; reply: string; overflow?: boolean } | "compact";

/** Test hooks: called for each recorded request (before it is answered) and each session event. */
export interface ChildHooks {
	onRequest?(request: Request, session: ChildSession): void;
	onEvent?(event: AgentSessionEvent, session: ChildSession): void;
}

/**
 * Runs one child process's turns: `steps` in a real implementer child session saved in `sessionDir` (a new one, or
 * `reopen`'s file), with `identity` in its environment. Every request the scripted model receives is recorded; summary
 * requests get a fixed checkpoint, except the first `failSummaries`, which fail.
 */
export async function runChild(
	fx: Fixture,
	identity: Identity,
	steps: Step[],
	sessionDir: string,
	reopen?: string,
	failSummaries = 0,
	hooks: ChildHooks = {},
) {
	const profile = loadProfiles(fx.cwd, fx.home, false, {}).get("implementer")!;
	const parsed = parseArgs(buildAgentArgs(profile, undefined, { dir: sessionDir, id: identity.id }, []));
	const env = subagentProcessEnv(profile, baseEnv(fx), identity);
	return withEnv(env, async () => {
		const manager = reopen ? SessionManager.open(reopen, sessionDir) : SessionManager.create(fx.cwd, sessionDir);
		const { session, faux } = await scriptedSession(
			fx,
			{ noMcp: parsed.noMcp, noSkills: parsed.noSkills, tools: parsed.tools, excludeTools: parsed.excludeTools },
			manager,
		);
		const requests: Request[] = [];
		let reply = "";
		let overflow = false;
		let failed = 0;
		const unsubscribe = hooks.onEvent ? session.subscribe((event) => hooks.onEvent?.(event, session)) : undefined;
		faux.setResponses(
			Array.from({ length: 20 }, () => (context: TranscriptContext) => {
				const texts = context.messages.filter((message) => message.role !== "system").map(messageText);
				// What a provider receives of the system message: its text and sections (its timestamp is in-memory only).
				const system = getCurrentSystemMessage(context.messages);
				const summary =
					system?.content === SUMMARIZATION_SYSTEM_PROMPT || texts.some((text) => text.includes(SUMMARY_REQUEST));
				const request = {
					system: JSON.stringify(system ? { content: system.content, sections: system.sections } : null),
					tools: JSON.stringify(getCurrentTools(context.messages)),
					texts,
					summary,
				};
				requests.push(request);
				hooks.onRequest?.(request, session);
				if (summary && failed < failSummaries) {
					failed += 1;
					throw new Error("summary provider down");
				}
				if (!summary && overflow) {
					overflow = false;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
				}
				return fauxAssistantMessage(summary ? "## Goal\nScripted checkpoint." : reply);
			}),
		);
		try {
			for (const step of steps) {
				if (step === "compact") {
					await session.compact();
					continue;
				}
				reply = step.reply;
				overflow = step.overflow === true;
				await session.prompt(step.prompt);
			}
			const last = session.messages.filter((message) => message.role === "assistant").at(-1);
			return {
				requests,
				final: last ? messageText(last) : undefined,
				file: manager.getSessionFile()!,
				entries: manager.getEntries(),
			};
		} finally {
			unsubscribe?.();
			session.dispose?.();
		}
	});
}

/** A long reply, so the earlier turns fall outside the retained tail and are summarized. */
export const long = (lead: string) => `${lead} ${"detail ".repeat(14_000)}`;
/** A task long enough that the checkpoint keeps it only behind a saved-file reference (over `USER_MESSAGE_CHARS`). */
export const longTask = (lead: string) => `${lead}\n${"Step: check the module and record what it does.\n".repeat(150)}`;
