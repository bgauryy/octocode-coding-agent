interface BashToken {
	raw: string;
	literal?: string;
	start: number;
	end: number;
}
export interface BashCommand {
	raw: string;
	tokens: BashToken[];
	assignments: Array<{ name: string; raw: string }>;
	ambiguousRedirect: boolean;
	/** Directory prefixes this command may run in, relative to the parsed command's own directory (`""` is that directory itself); absent when a `cd` before it cannot be followed. */
	dirs?: string[];
	/** True for a `cd`, `pushd` or `popd`, also behind `builtin` or `command`. */
	movesDirectory?: boolean;
}
export interface BashFileTarget {
	kind: "read" | "write";
	raw: string;
	path?: string;
	uncertain?: string;
	policyOnly?: boolean;
	/** As `BashCommand.dirs`, for the command or redirect that names this target. */
	dirs?: string[];
	position: number;
}
export interface BashSyntax {
	wholeAllow: boolean;
	commands: BashCommand[];
	incomplete: boolean;
	/** Why the parse is incomplete: the first construct it does not model (a node type such as `heredoc_redirect`) or the parse limit it hit. */
	unsupported?: string;
	targets: BashFileTarget[];
}
