/** An item about to be completed or closed by this process's `backlog` tool. */
export interface CompletionInfo {
	ref: string;
	title: string;
	goal: string;
	assignee?: string;
	change: "done" | "closed";
	/** The completion or close the call carries, as given. */
	completion?: unknown;
	close?: unknown;
}
