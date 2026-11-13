/** Read-only context-view data; this explanation is never appended to the model's messages. */
export interface ContextLifecycle {
	enabled: boolean;
	recordedCompactions: number;
	activeCheckpoints: number;
	otherMessages: number;
	keepRecentTokens: number;
	persistent: boolean;
	latest: { at: string; tokensBefore: number; separateCheckpoint: boolean } | null;
}

export function renderContextLifecycle(state: ContextLifecycle, threshold: number | null): string {
	const number = (value: number) => value.toLocaleString();
	const automatic = !state.enabled
		? "Automatic compaction is off"
		: threshold === null
			? "Automatic threshold needs a selected model"
			: `Automatic above ${number(threshold)} tokens when history is eligible`;
	const latest = state.latest
		? `Latest: ${state.latest.at}; ${number(state.latest.tokensBefore)} tokens before compaction${state.latest.separateCheckpoint ? "; full checkpoint saved separately" : ""}.`
		: "No checkpoint on this branch yet.";
	return [
		"**Compaction and continuation**",
		`${number(state.recordedCompactions)} recorded compactions on this branch · ${number(state.activeCheckpoints)} active ${state.activeCheckpoints === 1 ? "checkpoint" : "checkpoints"} · ${number(state.otherMessages)} other projected messages.`,
		latest,
		"| Stage | What happens |\n| --- | --- |",
		`| Trigger | ${automatic}; /compact calls it manually. |`,
		"| Summarize | Write a checkpoint of current goals, constraints, decisions, evidence and next actions. |",
		`| Compact | ${state.persistent ? "Save the checkpoint and original transcript" : "Record the checkpoint in memory"}; replace older active history and retain recent messages (target: ${number(state.keepRecentTokens)} tokens). |`,
		"| Continue | The next model turn uses instructions, the newest checkpoint and recent messages; check current work before retrying effects. |",
		"",
		"| Layer | What it keeps / how to retrieve it |\n| --- | --- |",
		"| Prompt cache | Reuses an identical prefix; cached input still occupies context. Keep instructions and tools stable; compaction changes the history after that prefix. |",
		"| Working context | The active checkpoint and recent messages for this task. A checkpoint is lossy; exact evidence stays behind references. |",
		"| Saved memory | Reusable notes recalled selectively across sessions. /memory manages them; compaction does not automatically save a memory note. |",
		state.persistent
			? "| History | Original transcripts and saved checkpoints. /archive browses compacted segments; ask the agent to search earlier conversations with the archive tool. |"
			: "| History | This session is not saved to a file; its history lasts only in the running session. Saved notes are separate. |",
	].join("\n");
}
