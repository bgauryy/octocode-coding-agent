import { type Container, getCapabilities, Image, Spacer } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { ensurePngTranscoder } from "../../../../utils/image-convert.ts";

interface ImageSource {
	data: string;
	mimeType: string;
	widthCells: number;
}

/** A row's inline images: the components shown, their inputs (to reuse a converted image) and their spacers. */
export interface ImageRows {
	components: Image[];
	sources: ImageSource[];
	spacers: Spacer[];
}

export const noImages = (): ImageRows => ({ components: [], sources: [], spacers: [] });

/**
 * Replace a row's images with those of `content`, reusing an unchanged image and its converted PNG data. Images show
 * only where the terminal draws them and the user wants them.
 */
export function updateImageRows(
	row: Container,
	previous: ImageRows,
	content: ReadonlyArray<{ type: string; data?: string; mimeType?: string }> | undefined,
	options: { show: boolean; widthCells: number; redraw: () => void },
): ImageRows {
	for (const image of previous.components) row.removeChild(image);
	for (const spacer of previous.spacers) row.removeChild(spacer);
	const next = noImages();
	if (!content || !getCapabilities().images || !options.show) return next;
	for (const block of content) {
		if (block.type !== "image" || !block.data || !block.mimeType) continue;
		const spacer = new Spacer(1);
		row.addChild(spacer);
		next.spacers.push(spacer);
		const source = { data: block.data, mimeType: block.mimeType, widthCells: options.widthCells };
		const index = next.components.length;
		const before = previous.sources[index];
		const image =
			before?.data === source.data && before.mimeType === source.mimeType && before.widthCells === source.widthCells
				? previous.components[index]
				: new Image(
						source.data,
						source.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ maxWidthCells: source.widthCells },
					);
		if (source.mimeType !== "image/png") ensurePngTranscoder(options.redraw);
		next.components.push(image);
		next.sources.push(source);
		row.addChild(image);
	}
	return next;
}
