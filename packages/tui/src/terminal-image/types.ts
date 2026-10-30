export type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
	/** Kitty images go through tmux passthrough as Unicode placeholder cells. Set only inside a tmux session. */
	kittyPlaceholders?: boolean;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	imageId?: number;
	/** Whether Kitty should apply its default cursor movement after placement. */
	moveCursor?: boolean;
}

export interface ImageCellSize {
	columns: number;
	rows: number;
}
