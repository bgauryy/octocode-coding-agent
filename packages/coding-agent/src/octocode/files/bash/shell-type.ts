import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The refusal for a bash call whose `type` names another declared tool (`type:"file"`): `type` only selects the shell,
 * so the model meant that tool. `toolNames` is read only when `type` is a string that is not a shell; undefined otherwise.
 */
export function shellTypeMisuse(args: unknown, toolNames: () => readonly string[]): string | undefined {
	if (!isRecord(args) || typeof args.type !== "string") return undefined;
	if (args.type === "bash" || args.type === "powershell") return undefined;
	if (!toolNames().includes(args.type)) return undefined;
	return `bash \`type\` selects the shell (bash or powershell), and "${args.type}" is a tool, not a shell. Call the "${args.type}" tool directly with its own parameters, and leave \`type\` out of bash calls.`;
}
