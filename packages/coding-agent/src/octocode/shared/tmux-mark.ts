/** A tmux pane as a label can name it: tmux's id and the `session:window.pane` text it lists. */
export interface PaneLabel {
	id: string;
	label: string;
}

/** `tmux work:2.0` for a pane tmux lists, else `tmux pane %12`. */
export function tmuxMark(paneId: string, panes: readonly PaneLabel[]): string {
	const pane = panes.find((candidate) => candidate.id === paneId);
	return pane ? `tmux ${pane.label}` : `tmux pane ${paneId}`;
}
