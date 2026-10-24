import { projectClaudeBash } from "../shared/claude-bash.ts";
import { isRecord } from "../../utils/guards.ts";
import { validateCodexOutput } from "./codex-output.ts";
/** Source dialects remain distinct even when their handlers use identical command text. */
export type HookProtocol = "octocode" | "claude" | "codex";

/** Host-specific event exclusions within the currently wired native event set. */
export function supportsHookEvent(protocol: HookProtocol, event: string): boolean {
	if (event === "PermissionRequest") return protocol !== "octocode";
	if (event === "Interrupt") return protocol === "codex";
	if (event === "PostToolUseFailure" || event === "StopFailure" || event === "PostToolBatch")
		return protocol === "claude";
	if (protocol === "octocode")
		return (
			event !== "SubagentStart" &&
			event !== "SubagentStop" &&
			event !== "UserPromptSubmit" &&
			event !== "PostCompact" &&
			event !== "SessionEnd"
		);
	if (event === "PreMessageSend" || event === "PostMessageReceive") return false;
	return protocol !== "codex" || event !== "Notification";
}

export function hookMatcher(
	protocol: HookProtocol,
	event: string,
	matcher: string,
): ((name: string) => boolean) | undefined {
	if (
		!matcher ||
		matcher === "*" ||
		(protocol !== "octocode" &&
			(event === "Interrupt" || event === "Stop" || event === "UserPromptSubmit" || event === "PostToolBatch"))
	)
		return () => true;
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
	if (
		!matcher ||
		matcher === "*" ||
		(protocol !== "octocode" &&
			(event === "Interrupt" || event === "Stop" || event === "UserPromptSubmit" || event === "PostToolBatch"))
	)
		return true;
	return names.some(test);
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
	if (
		metadata.child &&
		(protocol === "claude" ||
			["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "UserPromptSubmit"].includes(
				event,
			))
	) {
		projected.agent_id ??=
			protocol === "codex" ? metadata.child.sessionId : metadata.child.agentName || metadata.child.sessionId;
		projected.agent_type ??= metadata.child.agentType;
	}
	if (
		metadata.permissionMode &&
		(protocol === "claude" ||
			[
				"PermissionRequest",
				"PreToolUse",
				"PostToolUse",
				"SessionStart",
				"UserPromptSubmit",
				"Stop",
				"SubagentStart",
				"SubagentStop",
				"Interrupt",
			].includes(event))
	)
		projected.permission_mode = metadata.permissionMode === "full" ? "bypassPermissions" : "default";
	if (
		metadata.model &&
		(protocol === "claude"
			? event === "SessionStart"
			: [
					"PermissionRequest",
					"PreToolUse",
					"PostToolUse",
					"SessionStart",
					"UserPromptSubmit",
					"PreCompact",
					"PostCompact",
					"Stop",
					"SubagentStart",
					"SubagentStop",
					"Interrupt",
				].includes(event))
	) {
		projected.model = metadata.model;
	}
	if (protocol === "claude" && pi_tool_name === "bash" && isRecord(payload.tool_input))
		projected.tool_input = projectClaudeBash(payload.tool_input);
	if (protocol === "codex") {
		if (
			metadata.turnId &&
			[
				"PermissionRequest",
				"PreToolUse",
				"PostToolUse",
				"UserPromptSubmit",
				"PreCompact",
				"PostCompact",
				"Stop",
				"SubagentStart",
				"SubagentStop",
				"Interrupt",
			].includes(event)
		)
			projected.turn_id = metadata.turnId;
		if (!projected.transcript_path) projected.transcript_path = null;
		if (pi_tool_name === "bash" && isRecord(payload.tool_input)) {
			projected.tool_input = { command: payload.tool_input.command };
		}
	}
	return projected;
}
