import {
	HOOK_CATALOG,
	HOOK_EVENTS,
	PROFILE_COMMAND_FIELDS,
	PROFILE_TIMEOUT_S,
	profileSupport,
	UPSTREAM_ONLY_EVENTS,
	type HookProtocol,
} from "../catalog.ts";
import { HOOK_MAX_TIMEOUT_S, type HookSource, type HookHandler, type HookConfig } from "../contracts.ts";
import { parseHttpHook } from "../http.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { claudeSessionEndOverride, hookMatcher } from "../profiles.ts";

export const emptyHooks = (): HookConfig =>
	Object.fromEntries(HOOK_EVENTS.map((event) => [event, []])) as unknown as HookConfig;

const HOST_NAMES = { claude: "Claude Code", codex: "Codex" } as const;

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
	const hooks = isRecord(value) ? value.hooks : undefined;
	if (hooks === undefined) return into;
	if (!isRecord(hooks)) {
		errors.push(`${source}: hooks must be an object; skipped`);
		return into;
	}
	for (const event of Object.keys(hooks)) {
		if (Object.hasOwn(HOOK_CATALOG, event)) continue;
		errors.push(
			protocol !== "octocode" && UPSTREAM_ONLY_EVENTS[protocol].includes(event)
				? `${source}: ${HOST_NAMES[protocol]} hook event ${event} is not implemented in Octocode yet; skipped`
				: `${source}: unsupported hook event ${event}; skipped`,
		);
	}
	for (const event of HOOK_EVENTS) {
		const groups = hooks[event];
		if (groups === undefined) continue;
		const support = profileSupport(protocol, event);
		if (!support) {
			errors.push(`${source}: unsupported ${protocol} hook event ${event}; skipped`);
			continue;
		}
		const defaultTimeout =
			protocol === "claude" && event === "SessionEnd"
				? (claudeSessionEndOverride() ?? 1500) / 1000
				: (support.timeout ?? PROFILE_TIMEOUT_S[protocol]);
		const maxTimeout = support.maxTimeout ?? HOOK_MAX_TIMEOUT_S;
		const gate: boolean = "gate" in HOOK_CATALOG[event];
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
						gate;
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
					if (!support.handlers.includes("mcp_tool"))
						return invalidHandler(`${HOST_NAMES[protocol]} ${event} does not support MCP hooks`);
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
							input: asRecord(hook.input),
							timeoutMs:
								(typeof hook.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0
									? Math.min(hook.timeout, maxTimeout)
									: defaultTimeout) * 1000,
							source,
							...(origin ? { origins: [origin] } : {}),
						},
					];
				}
				if (isRecord(hook) && hook.type === "http" && support.handlers.includes("http")) {
					return parseHttpHook(hook, source, origin, defaultTimeout, errors);
				}
				if (isRecord(hook) && hook.type === "prompt" && support.handlers.includes("prompt")) {
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
				const accepted = PROFILE_COMMAND_FIELDS[protocol];
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
				if (protocol === "claude" && (hook.async === true || hook.asyncRewake === true) && support.synchronous)
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
				const supportsContextLimit = support.contextLimit === true;
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
