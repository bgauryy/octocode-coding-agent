import type { JsonObject } from "@octocodeai/octocode-ai";
import { parsePermissionUpdates } from "../shared/permission-updates.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { HookRun, HookVerdict } from "./contracts.ts";
import type { HookProtocol } from "./catalog.ts";
import { validateCodexOutput } from "./codex-output.ts";

export function permissionOutput(run: HookRun, protocol: HookProtocol): HookVerdict {
	if (run.timedOut) return {};
	if (protocol === "codex" && run.code === 2)
		return run.stderr.trim()
			? { permissionDecision: "deny", block: run.stderr.trim() }
			: { error: "PermissionRequest exit 2 requires a denial reason" };
	if (run.code !== 0 && !(protocol === "claude" && run.code === 2)) return {};
	if (!run.stdout.trim()) return {};
	let output: unknown;
	try {
		output = JSON.parse(run.stdout);
	} catch {
		return /^[\s]*[[{]/.test(run.stdout) ? { error: "Invalid PermissionRequest JSON output" } : {};
	}
	if (!isRecord(output)) return { error: "PermissionRequest output must be an object" };
	const warning = typeof output.systemMessage === "string" ? { systemMessage: output.systemMessage } : {};
	if (protocol === "codex") {
		const error = validateCodexOutput("PermissionRequest", output);
		if (error) return { ...warning, error };
	}
	if (protocol === "claude" && output.continue === false)
		return {
			...warning,
			permissionDecision: "deny",
			permissionInterrupt: true,
			block:
				typeof output.stopReason === "string" && output.stopReason.trim()
					? output.stopReason.trim()
					: "Stopped by PermissionRequest hook",
		};
	const specific = output.hookSpecificOutput;
	if (specific == null) return warning;
	if (!isRecord(specific))
		return {
			...warning,
			error: "PermissionRequest hookSpecificOutput must be an object",
		};
	if (protocol === "claude" && specific.hookEventName !== "PermissionRequest")
		return {
			...warning,
			error: "PermissionRequest requires its own hookEventName",
		};
	const decision = specific.decision;
	if (decision == null) return warning;
	if (!isRecord(decision) || !["allow", "deny"].includes(String(decision.behavior)))
		return { ...warning, error: "Invalid PermissionRequest decision" };
	if (decision.message != null && typeof decision.message !== "string")
		return { ...warning, error: "PermissionRequest message must be a string" };
	if (protocol === "claude" && decision.interrupt != null && typeof decision.interrupt !== "boolean")
		return {
			...warning,
			error: "PermissionRequest interrupt must be a boolean",
		};
	if (protocol === "claude" && decision.behavior === "deny")
		return {
			...warning,
			permissionDecision: "deny",
			...(decision.interrupt === true ? { permissionInterrupt: true } : {}),
			block:
				typeof decision.message === "string" && decision.message.trim()
					? decision.message.trim()
					: "PermissionRequest hook denied approval",
		};
	const hasInput = protocol === "claude" && Object.hasOwn(decision, "updatedInput");
	if (
		protocol === "codex" &&
		(decision.updatedInput != null || decision.updatedPermissions != null || decision.interrupt === true)
	)
		return {
			...warning,
			error: "PermissionRequest updatedInput or updatedPermissions are unsupported by this adapter",
		};
	if (hasInput && !isRecord(decision.updatedInput))
		return {
			...warning,
			error: "PermissionRequest updatedInput must be an object",
		};

	let updatedPermissions: ReturnType<typeof parsePermissionUpdates> | undefined;
	try {
		if (protocol === "claude" && decision.updatedPermissions != null)
			updatedPermissions = parsePermissionUpdates(decision.updatedPermissions);
	} catch (error) {
		return {
			...warning,
			error: errorMessage(error),
		};
	}

	return decision.behavior === "allow"
		? {
				...warning,
				permissionDecision: "allow",
				...(updatedPermissions?.length ? { updatedPermissions } : {}),
				...(hasInput
					? {
							updatedInput: decision.updatedInput as JsonObject,
							updatedInputProtocol: "claude" as const,
						}
					: {}),
			}
		: {
				...warning,
				permissionDecision: "deny",
				...(protocol === "claude" && decision.interrupt === true ? { permissionInterrupt: true as const } : {}),
				block:
					typeof decision.message === "string" && decision.message.trim()
						? decision.message.trim()
						: "PermissionRequest hook denied approval",
			};
}
