import { isRecord } from "../shared/util.ts";

export function usesCodexSpecificDecision(specific: Record<string, unknown>): boolean {
	return ["permissionDecision", "permissionDecisionReason", "updatedInput"].some(key => specific[key] != null);
}

const WIRE_EVENTS = ["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "Interrupt"];

function validateWire(event: string, json: Record<string, unknown>, fields: string[], specificFields?: string[]): string | undefined {
 const invalid = (detail: string) => `Codex ${event}: ${detail}`;
 const extra = Object.keys(json).filter(key => !["continue", "stopReason", "suppressOutput", "systemMessage", ...fields].includes(key));
 if (extra.length) return invalid(`unknown fields: ${extra.join(", ")}`);
 for (const key of ["continue", "suppressOutput"]) if (key in json && typeof json[key] !== "boolean") return invalid(`${key} must be a boolean`);
 for (const key of ["stopReason", "systemMessage", "reason"]) if (json[key] != null && typeof json[key] !== "string") return invalid(`${key} must be a string`);
 if (json.decision != null && (typeof json.decision !== "string" || !(event === "PreToolUse" ? ["approve", "block"] : ["block"]).includes(json.decision))) return invalid("invalid decision");
 if (json.hookSpecificOutput != null) {
  if (!isRecord(json.hookSpecificOutput)) return invalid("hookSpecificOutput must be an object");
  const specific = json.hookSpecificOutput;
  // The runtime accepts the wire enum; event-specific const tags are schema annotations.
  if (typeof specific.hookEventName !== "string" || !WIRE_EVENTS.includes(specific.hookEventName)) return invalid("invalid or missing hookEventName");
  const unknown = Object.keys(specific).filter(key => !["hookEventName", ...(specificFields ?? [])].includes(key));
  if (unknown.length) return invalid(`unknown hookSpecificOutput fields: ${unknown.join(", ")}`);
  for (const key of ["additionalContext", "permissionDecisionReason"]) if (specific[key] != null && typeof specific[key] !== "string") return invalid(`${key} must be a string`);
  if (specific.permissionDecision != null && (typeof specific.permissionDecision !== "string" || !["allow", "deny", "ask"].includes(specific.permissionDecision))) return invalid("invalid permissionDecision");
 }
 return undefined;
}

/** Validate implemented Codex command-output contracts against the pinned runtime schema. */
export function validateCodexOutput(event: string, json: Record<string, unknown>): string | undefined {
	if (event === "PermissionRequest") {
		const error = validateWire(
			event,
			json,
			["hookSpecificOutput"],
			["decision"],
		);
		if (error) return error;
		if (
			json.continue === false ||
			json.stopReason != null ||
			json.suppressOutput === true
		)
			return "Codex PermissionRequest: unsupported universal control";
		const specific = isRecord(json.hookSpecificOutput)
			? json.hookSpecificOutput
			: {};
		const decision = specific.decision;
		if (decision == null) return undefined;
		if (
			!isRecord(decision) ||
			!["allow", "deny"].includes(String(decision.behavior)) ||
			Object.keys(decision).some(
				(key) =>
					![
						"behavior",
						"updatedInput",
						"updatedPermissions",
						"message",
						"interrupt",
					].includes(key),
			)
		)
			return "Codex PermissionRequest: invalid decision";
		if (decision.message != null && typeof decision.message !== "string")
			return "Codex PermissionRequest: invalid message";
		if (
			decision.interrupt !== undefined &&
			typeof decision.interrupt !== "boolean"
		)
			return "Codex PermissionRequest: invalid interrupt";
		if (
			decision.updatedInput != null ||
			decision.updatedPermissions != null ||
			decision.interrupt === true
		)
			return "Codex PermissionRequest: unsupported decision effects";
		return undefined;
	}
 if (event === "Interrupt") return Object.keys(json).some(key => key !== "systemMessage") || (json.systemMessage != null && typeof json.systemMessage !== "string") ? "Codex Interrupt: only optional string systemMessage is supported" : undefined;
 if (event === "PreToolUse" || event === "PostToolUse") return validateCodexToolOutput(event, json);
 if (!["SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop"].includes(event)) return undefined;
 const decision = event === "SubagentStop" || event === "Stop" || event === "UserPromptSubmit";
 const context = event === "SubagentStart" || event === "SessionStart" || event === "UserPromptSubmit";
 const error = validateWire(event, json, [...(decision ? ["decision", "reason"] : []), ...(context ? ["hookSpecificOutput"] : [])], context ? ["additionalContext"] : undefined);
 if (error) return error;
 if (json.decision === "block" && !(typeof json.reason === "string" && json.reason.trim())) return `Codex ${event}: decision:block requires a non-empty reason`;
 return undefined;
}

function validateCodexToolOutput(event: "PreToolUse" | "PostToolUse", json: Record<string, unknown>): string | undefined {
 const invalid = (detail: string) => `Codex ${event}: ${detail}`;
 const error = validateWire(event, json, ["decision", "reason", "hookSpecificOutput"], event === "PreToolUse" ? ["additionalContext", "permissionDecision", "permissionDecisionReason", "updatedInput"] : ["additionalContext", "updatedMCPToolOutput"]);
 if (error) return error;
 const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
	if (json.suppressOutput === true) return invalid("unsupported suppressOutput");
	if (event === "PostToolUse") {
		if (specific.updatedMCPToolOutput != null) return invalid("unsupported updatedMCPToolOutput");
		if (json.decision === "block" && !(typeof json.reason === "string" && json.reason.trim())) return invalid("decision:block requires a non-empty reason");
		if (json.decision == null && json.continue !== false && json.reason != null) return invalid("reason without decision");
		return undefined;
	}
	if (json.continue === false) return invalid("unsupported continue:false");
	if (json.stopReason != null) return invalid("unsupported stopReason");
	if (usesCodexSpecificDecision(specific)) {
		if (specific.updatedInput != null && specific.permissionDecision !== "allow") return invalid("updatedInput requires permissionDecision allow");
		if (specific.permissionDecision === "allow" && specific.updatedInput == null) return invalid("permissionDecision allow requires updatedInput");
		if (specific.permissionDecision === "ask") return invalid("unsupported permissionDecision: ask");
		if (specific.permissionDecision === "deny" && !(typeof specific.permissionDecisionReason === "string" && specific.permissionDecisionReason.trim())) return invalid("permissionDecision deny requires a non-empty permissionDecisionReason");
		if (specific.permissionDecision == null && specific.permissionDecisionReason != null) return invalid("permissionDecisionReason without permissionDecision");
	} else {
		if (json.decision === "approve") return invalid("unsupported decision: approve");
		if (json.decision === "block" && !(typeof json.reason === "string" && json.reason.trim())) return invalid("decision:block requires a non-empty reason");
		if (json.decision == null && json.reason != null) return invalid("reason without decision");
	}
	return undefined;
}
