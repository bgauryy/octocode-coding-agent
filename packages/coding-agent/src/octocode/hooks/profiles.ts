import { projectClaudeBash } from "../shared/claude-bash.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type HookProtocol, profileSupport } from "./catalog.ts";
import { validateCodexOutput } from "./codex-output.ts";
/** Whether `protocol` accepts `event` (see the catalog). */
export const supportsHookEvent = (protocol: HookProtocol, event: string): boolean =>
	profileSupport(protocol, event) !== undefined;

/** Empty, `*`, or an event whose upstream host ignores matchers: every group matches. */
const matchesAll = (protocol: HookProtocol, event: string, matcher: string): boolean =>
	!matcher || matcher === "*" || profileSupport(protocol, event)?.ignoresMatcher === true;

export function hookMatcher(
	protocol: HookProtocol,
	event: string,
	matcher: string,
): ((name: string) => boolean) | undefined {
	if (matchesAll(protocol, event, matcher)) return () => true;
	if (protocol === "claude" && /^[\w\- ,|]+$/.test(matcher)) {
		const alternatives = matcher.split(/[|,]/).map((name) => name.trim());
		return (name) => alternatives.includes(name);
	}
	try {
		const pattern = new RegExp(protocol === "octocode" ? `^(?:${matcher})$` : matcher);
		return (name) => pattern.test(name);
	} catch {
		return undefined;
	}
}

export function matchesHook(protocol: HookProtocol, event: string, matcher: string, names: string[]): boolean {
	const test = hookMatcher(protocol, event, matcher);
	if (!test) return false;
	return matchesAll(protocol, event, matcher) || names.some(test);
}

/** Validate source output before the dispatcher applies its failure policy. */
export function unsupportedOutput(
	protocol: HookProtocol,
	event: string,
	json: Record<string, unknown>,
): string | undefined {
	return protocol === "codex" ? validateCodexOutput(event, json) : undefined;
}

export function claudeSessionEndOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const value = Number(env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Codex shell hooks expose the stable command field, not native execution options. */
export function hookPayload(
	protocol: HookProtocol,
	payload: Record<string, unknown>,
	metadata: {
		model?: string;
		turnId?: string;
		permissionMode?: "manual" | "workspace" | "full";
		child?: { sessionId: string; agentName?: string; agentType: string };
	} = {},
): Record<string, unknown> {
	if (protocol === "octocode") return payload;
	const { pi_tool_name, ...projected } = payload;
	const event = String(payload.hook_event_name);
	const input = profileSupport(protocol, event)?.input ?? [];
	if (metadata.child && input.includes("agent")) {
		projected.agent_id ??=
			protocol === "codex" ? metadata.child.sessionId : metadata.child.agentName || metadata.child.sessionId;
		projected.agent_type ??= metadata.child.agentType;
	}
	if (metadata.permissionMode && input.includes("permission_mode"))
		projected.permission_mode = metadata.permissionMode === "full" ? "bypassPermissions" : "default";
	if (metadata.model && input.includes("model")) projected.model = metadata.model;
	if (protocol === "claude" && pi_tool_name === "bash" && isRecord(payload.tool_input))
		projected.tool_input = projectClaudeBash(payload.tool_input);
	if (protocol === "codex") {
		if (metadata.turnId && input.includes("turn_id")) projected.turn_id = metadata.turnId;
		if (!projected.transcript_path) projected.transcript_path = null;
		if (pi_tool_name === "bash" && isRecord(payload.tool_input)) {
			projected.tool_input = { command: payload.tool_input.command };
		}
	}
	return projected;
}
