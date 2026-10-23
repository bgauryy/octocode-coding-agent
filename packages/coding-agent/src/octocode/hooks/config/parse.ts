import {
	HOOK_EVENTS,
	HOOK_MAX_TIMEOUT_S as MAX_TIMEOUT_S,
	type HookSource,
	type HookHandler,
	type HookConfig,
} from "../contracts.ts";
import { parseHttpHook } from "../http.ts";
import { isRecord } from "../../shared/util.ts";
import { claudeSessionEndOverride, hookMatcher, supportsHookEvent, type HookProtocol } from "../profiles.ts";

const DEFAULT_TIMEOUT_S = 60;

export const emptyHooks = (): HookConfig => ({
	PreToolUse: [],
	PermissionRequest: [],
	PostToolUse: [],
	PostToolUseFailure: [],
	PostToolBatch: [],
	SessionStart: [],
	SubagentStart: [],
	SubagentStop: [],
	Interrupt: [],
	SessionEnd: [],
	UserPromptSubmit: [],
	PreCompact: [],
	PostCompact: [],
	Stop: [],
	StopFailure: [],
	Notification: [],
	PreMessageSend: [],
	PostMessageReceive: [],
});

/** Adds the command hooks in one parsed file to `into`; a group whose matcher is not a valid pattern is kept (it matches nothing) and named in `errors`. */
export function parseHooks(
	value: unknown,
	source: string,
	into: HookConfig = emptyHooks(),
	errors: string[] = [],
	origin?: HookSource,
	protocol: HookProtocol = "octocode",
): HookConfig {
	if (isRecord(value) && value.disableAllHooks === true) return into;
	const profileTimeout = protocol === "octocode" ? DEFAULT_TIMEOUT_S : 600;
	const hooks = isRecord(value) ? value.hooks : undefined;
	if (hooks === undefined) return into;
	if (!isRecord(hooks)) {
		errors.push(`${source}: hooks must be an object; skipped`);
		return into;
	}
	for (const event of Object.keys(hooks)) {
		if (!(HOOK_EVENTS as readonly string[]).includes(event))
			errors.push(`${source}: unsupported hook event ${event}; skipped`);
	}
	for (const event of HOOK_EVENTS) {
		const defaultTimeout =
			event === "Interrupt"
				? 1
				: event === "SessionEnd"
					? protocol === "codex"
						? 1
						: (claudeSessionEndOverride() ?? 1500) / 1000
					: protocol === "claude" && event === "UserPromptSubmit"
						? 30
						: profileTimeout;
		const maxTimeout = protocol === "codex" && (event === "SessionEnd" || event === "Interrupt") ? 3 : MAX_TIMEOUT_S;
		const groups = hooks[event];
		if (groups === undefined) continue;
		if (!supportsHookEvent(protocol, event)) {
			errors.push(`${source}: unsupported ${protocol} hook event ${event}; skipped`);
			continue;
		}
		if (!Array.isArray(groups)) {
			errors.push(`${source}: ${event} must be an array; skipped`);
			continue;
		}
		for (const group of groups) {
			if (
				!isRecord(group) ||
				!Array.isArray(group.hooks) ||
				(group.matcher !== undefined && typeof group.matcher !== "string")
			) {
				errors.push(`${source}: invalid ${event} matcher group; skipped`);
				continue;
			}
			const extraGroupFields = Object.keys(group).filter((key) => key !== "matcher" && key !== "hooks");
			if (extraGroupFields.length) {
				errors.push(`${source}: unsupported ${event} group fields ${extraGroupFields.join(", ")}; skipped`);
				continue;
			}
			const commands = group.hooks.flatMap((hook): HookHandler[] => {
				const invalidHandler = (failure: string): HookHandler[] => {
					const required =
						isRecord(hook) &&
						(hook.failClosed === true || (protocol === "claude" && hook.onFailure === "block")) &&
						(event === "PermissionRequest" ||
							event === "PreToolUse" ||
							event === "PreMessageSend" ||
							event === "UserPromptSubmit");
					errors.push(`${source}: ${failure}; ${required ? "failClosed denies matching calls" : "skipped"}`);
					if (!required) return [];
					return [
						{
							command: typeof hook.command === "string" ? hook.command : "",
							timeoutMs: defaultTimeout * 1000,
							...(protocol !== "octocode" ? { protocol } : {}),
							source,
							...(origin ? { origins: [origin] } : {}),
							...(protocol === "claude" && hook.onFailure === "block" ? { onFailure: "block" as const } : {}),
							failClosed: true,
							configurationError: failure,
						},
					];
				};
				if (protocol === "claude" && isRecord(hook) && Object.hasOwn(hook, "once")) {
					if (typeof hook.once !== "boolean") return invalidHandler("once must be a boolean");
					// This reader loads settings and plugin files; Claude honors once only in skill frontmatter.
					const settingsHook = { ...hook };
					delete settingsHook.once;
					hook = settingsHook;
				}
				if (protocol === "codex" && event === "Interrupt" && isRecord(hook) && hook.timeout != null) {
					if (!Number.isSafeInteger(hook.timeout) || (hook.timeout as number) < 0)
						return invalidHandler("Interrupt timeout must be a non-negative safe integer");
				}
				if (isRecord(hook) && hook.type === "mcp_tool" && protocol !== "octocode") {
					if (protocol === "codex" && event === "SessionEnd")
						return invalidHandler("Codex SessionEnd does not support MCP hooks");
					const invalid =
						typeof hook.server !== "string" ||
						!hook.server.trim() ||
						typeof hook.tool !== "string" ||
						!hook.tool.trim() ||
						(hook.input !== undefined && !isRecord(hook.input)) ||
						Object.keys(hook).some(
							(key) => !["type", "server", "tool", "input", "timeout", "statusMessage"].includes(key),
						);
					if (invalid) return invalidHandler("invalid or unsupported MCP hook fields");
					return [
						{
							type: "mcp_tool",
							protocol,
							server: hook.server as string,
							tool: hook.tool as string,
							input: isRecord(hook.input) ? hook.input : {},
							timeoutMs:
								(typeof hook.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0
									? Math.min(hook.timeout, maxTimeout)
									: defaultTimeout) * 1000,
							source,
							...(origin ? { origins: [origin] } : {}),
						},
					];
				}
				if (isRecord(hook) && hook.type === "http" && protocol === "claude" && event !== "SessionStart") {
					return parseHttpHook(hook, source, origin, defaultTimeout, errors);
				}
				if (
					isRecord(hook) &&
					hook.type === "prompt" &&
					protocol === "claude" &&
					[
						"PermissionRequest",
						"PreToolUse",
						"PostToolUse",
						"PostToolUseFailure",
						"PostToolBatch",
						"Stop",
						"SubagentStop",
						"UserPromptSubmit",
					].includes(event)
				) {
					if (
						typeof hook.prompt !== "string" ||
						!hook.prompt.trim() ||
						(hook.model !== undefined && (typeof hook.model !== "string" || !hook.model.trim())) ||
						(hook.continueOnBlock !== undefined && typeof hook.continueOnBlock !== "boolean") ||
						(hook.timeout !== undefined &&
							(typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout) || hook.timeout <= 0)) ||
						Object.keys(hook).some(
							(key) =>
								!["type", "prompt", "model", "timeout", "continueOnBlock", "statusMessage", "failClosed"].includes(key),
						)
					)
						return invalidHandler("invalid or unsupported prompt hook fields");
					return [
						{
							type: "prompt",
							protocol,
							prompt: hook.prompt,
							...(typeof hook.model === "string" ? { model: hook.model } : {}),
							...(typeof hook.continueOnBlock === "boolean" ? { continueOnBlock: hook.continueOnBlock } : {}),
							timeoutMs: (typeof hook.timeout === "number" ? Math.min(hook.timeout, maxTimeout) : 30) * 1000,
							source,
							...(origin ? { origins: [origin] } : {}),
							...(hook.failClosed === true ? { failClosed: true as const } : {}),
						},
					];
				}
				if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string" || !hook.command.trim()) {
					return invalidHandler(`${event} requires a command hook with a non-empty command`);
				}
				const accepted = [
					"type",
					"command",
					"timeout",
					"failClosed",
					"statusMessage",
					...(protocol === "claude" ? ["args", "onFailure", "async", "asyncRewake"] : []),
					...(protocol === "codex" ? ["commandWindows", "async", "additionalContextLimit"] : []),
				];
				const unsupported = Object.keys(hook).filter((key) => !accepted.includes(key));
				const invalid: string[] = [];
				if (
					protocol === "codex" &&
					hook.additionalContextLimit != null &&
					(!Number.isSafeInteger(hook.additionalContextLimit) || (hook.additionalContextLimit as number) < 0)
				)
					invalid.push("additionalContextLimit must be a non-negative safe integer");
				if (protocol !== "octocode" && hook.async !== undefined && typeof hook.async !== "boolean")
					invalid.push("async must be a boolean");
				if (protocol === "claude" && hook.asyncRewake !== undefined && typeof hook.asyncRewake !== "boolean")
					invalid.push("asyncRewake must be a boolean");
				if (protocol === "claude" && (hook.async === true || hook.asyncRewake === true) && event === "SessionEnd")
					invalid.push("async SessionEnd requires an unavailable teardown scheduler");
				if (
					protocol === "claude" &&
					hook.args !== undefined &&
					(!Array.isArray(hook.args) || !hook.args.every((arg) => typeof arg === "string"))
				)
					invalid.push("args must be an array of strings");
				if (
					protocol === "claude" &&
					hook.onFailure !== undefined &&
					hook.onFailure !== "block" &&
					hook.onFailure !== "continue"
				)
					invalid.push('onFailure must be "block" or "continue"');
				if (
					protocol === "codex" &&
					hook.commandWindows !== undefined &&
					(typeof hook.commandWindows !== "string" || !hook.commandWindows.trim())
				)
					invalid.push("commandWindows must be a non-empty string");
				if (unsupported.length || invalid.length) {
					return invalidHandler(
						[
							...(unsupported.length ? [`unsupported ${event} command fields ${unsupported.join(", ")}`] : []),
							...invalid,
						].join("; "),
					);
				}

				const hasContextLimit = protocol === "codex" && hook.additionalContextLimit != null;
				const supportsContextLimit = [
					"PreToolUse",
					"PostToolUse",
					"SessionStart",
					"SubagentStart",
					"UserPromptSubmit",
				].includes(event);
				if (hasContextLimit && !supportsContextLimit)
					errors.push(
						`${source}: ignoring additionalContextLimit for ${event}: this event cannot emit additionalContext`,
					);
				const seconds =
					typeof hook.timeout === "number" && hook.timeout > 0 ? Math.min(hook.timeout, maxTimeout) : defaultTimeout;
				return [
					{
						command: hook.command,
						...(hasContextLimit && supportsContextLimit
							? { additionalContextLimit: hook.additionalContextLimit as number }
							: {}),
						...(protocol !== "octocode" && typeof hook.async === "boolean" ? { async: hook.async } : {}),
						...(protocol === "claude" && typeof hook.asyncRewake === "boolean"
							? { asyncRewake: hook.asyncRewake }
							: {}),
						...(protocol === "claude" && Array.isArray(hook.args) ? { args: hook.args as string[] } : {}),
						...(protocol === "claude" && (hook.onFailure === "block" || hook.onFailure === "continue")
							? { onFailure: hook.onFailure }
							: {}),
						...(protocol === "codex" && typeof hook.commandWindows === "string"
							? { commandWindows: hook.commandWindows }
							: {}),
						timeoutMs: seconds * 1000,
						...(protocol !== "octocode" ? { protocol } : {}),
						source,
						...(origin ? { origins: [origin] } : {}),
						...(hook.failClosed === true ? { failClosed: true as const } : {}),
					},
				];
			});
			if (commands.length === 0) continue;
			const matcher = typeof group.matcher === "string" ? group.matcher : "";
			if (!hookMatcher(protocol, event, matcher))
				errors.push(`${source}: ${event} matcher "${matcher}" is not a valid pattern, so its hooks never run`);
			into[event].push({ matcher, hooks: commands });
		}
	}
	return into;
}
