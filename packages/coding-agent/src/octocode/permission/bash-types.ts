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
}
export interface BashFileTarget {
	kind: "read" | "write";
	raw: string;
	path?: string;
	uncertain?: string;
	policyOnly?: boolean;
	position: number;
}
export interface BashSyntax {
	wholeAllow: boolean;
	commands: BashCommand[];
	incomplete: boolean;
	targets: BashFileTarget[];
}
