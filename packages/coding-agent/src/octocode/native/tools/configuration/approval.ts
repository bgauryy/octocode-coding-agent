import { redactData, redactSecrets } from "@octocodeai/octocode-common/sanitize";
import type { ConfigEntry, ConfigOp, ConfigScope } from "../../../../configuration/index.ts";
import { sensitiveOp } from "../../../../configuration/sensitive.ts";
import { clip } from "../../../shared/text.ts";

const show = (value: unknown): string =>
	value === undefined ? "(unset)" : clip(redactSecrets(JSON.stringify(redactData(value)) ?? "undefined"), 400);

function afterOf(op: ConfigOp): unknown {
	switch (op.verb) {
		case "set":
		case "add":
			return op.value;
		case "enable":
			return "on";
		case "disable":
			return "off";
		case "unset":
		case "remove":
			return undefined;
	}
}

/** The approval the user answers: what changes, where, from what to what, and the warning for a security-relevant entry. */
export function approvalText(op: ConfigOp, scope: ConfigScope, before: ConfigEntry | undefined, file: string): string {
	const warning = sensitiveOp(op);
	const lines = [
		...(warning ? [`WARNING, security-relevant: ${warning}.`, ""] : []),
		`${op.verb} ${op.id}`,
		`scope: ${scope === "project" ? "workspace" : scope}`,
		`file: ${file}`,
		`${show(before?.scopes[scope])} -> ${op.verb === "unset" || op.verb === "remove" ? "(removed)" : show(afterOf(op))}`,
	];
	return lines.join("\n");
}

export const approvalTitle = (op: ConfigOp): string =>
	`${sensitiveOp(op) ? "Security-relevant configuration change" : "Configuration change"}: allow the agent to ${op.verb} ${op.id}?`;
