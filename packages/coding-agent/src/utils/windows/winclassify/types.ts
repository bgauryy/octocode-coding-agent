/** One argument of a parsed command: a `-Name[:value]` parameter, or a value (`value` set when it is a string constant). */
export interface ScriptElement {
	param?: string;
	arg?: string;
	text: string;
	value?: string;
}

/** One command of a parsed script (nested ones included); `name` is null when it is computed (`& $tool`). */
export interface ScriptCommand {
	name: string | null;
	args: ScriptElement[];
}

/** Parses a script into its commands; undefined when it does not parse or no parser is available. */
export type ParseScript = (script: string) => Promise<ScriptCommand[] | undefined>;

/** `parsed: false` means no verdict could be reached (parse error, no helper, unwrapping impossible): treat it as destructive. */
export interface Classification {
	destructive?: string;
	parsed: boolean;
}
