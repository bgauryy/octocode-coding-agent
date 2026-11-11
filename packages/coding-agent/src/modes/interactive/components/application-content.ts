import {
	applicationContentText,
	parseApplicationMessage,
	type ApplicationAsset,
	type ApplicationAssetPayload,
	type ApplicationContentBlock,
	type ApplicationMessage,
} from "@octocodeai/octocode-contracts";
import { Container, Image, Text, getCapabilities } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../../../theme/theme.ts";

type AssetReader = (id: string) => ApplicationAssetPayload | undefined;
export interface ContentOptions {
	cwd?: string;
	readAsset?: AssetReader;
	showImages?: boolean;
	imageWidthCells?: number;
	requestRender?: () => void;
}

/** Full JSON is loaded only when a preview carries a reference; repeated deltas reuse the same decoded asset. */
export class FullContentReader {
	private readonly values = new Map<string, Record<string, unknown>>();
	read(asset: ApplicationAsset | undefined, reader?: AssetReader): Record<string, unknown> | undefined {
		if (!asset || !reader) return undefined;
		const key = `${asset.id}:${asset.revision ?? ""}`;
		const cached = this.values.get(key);
		if (cached) return cached;
		const payload = reader(asset.id);
		if (payload?.encoding !== "utf8" || payload.asset.mimeType !== "application/json") return undefined;
		try {
			const value: unknown = JSON.parse(payload.data);
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
			this.values.set(key, value as Record<string, unknown>);
			if (this.values.size > 8) this.values.delete(this.values.keys().next().value!);
			return value as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}

	data(first: ApplicationAsset | undefined, reader?: AssetReader): Record<string, unknown> | undefined {
		let asset = first;
		const seen = new Set<string>();
		let merged: Record<string, unknown> | undefined;
		for (let depth = 0; asset && depth < 8 && !seen.has(asset.id); depth++) {
			seen.add(asset.id);
			const value = this.read(asset, reader);
			if (!value) break;
			merged = Object.assign(merged ?? {}, value);
			asset =
				value.full && typeof value.full === "object" && "id" in value.full
					? (value.full as ApplicationAsset)
					: undefined;
		}
		return merged;
	}

	message(message: ApplicationMessage, reader?: AssetReader): ApplicationMessage {
		const value = this.data(message.full, reader);
		if (!message.full) return message;
		const complete = parseApplicationMessage(value);
		if (complete?.id === message.id) {
			return {
				...complete,
				...message,
				content: complete.content,
				text: complete.text,
			};
		}
		return {
			...message,
			content: [
				...(message.content ?? []),
				{
					id: `${message.id}:unavailable`,
					type: "unsupported",
					providerType: "full-message",
					text: `[Full message unavailable: ${message.full.id}]`,
				},
			],
		};
	}
}

/** Resolve display text through the same asset reference used by remote consumers. */
export function contentText(block: ApplicationContentBlock, readAsset?: AssetReader): string {
	if ("full" in block && block.full) {
		const value = readAsset?.(block.full.id);
		if (value?.encoding === "utf8") return value.data;
	}
	return applicationContentText([block]);
}

/** Binary attachments keep a visible description when graphics are unavailable or disabled. */
export class ContentAttachmentComponent extends Container {
	private imageProtocol = getCapabilities().images;
	private image?: Image;
	private imageKey?: string;
	private imageReader?: AssetReader;
	private pngTranscoderRequested = false;
	private block: ApplicationContentBlock;
	private options: ContentOptions;
	constructor(block: ApplicationContentBlock, options: ContentOptions = {}) {
		super();
		this.block = block;
		this.options = options;
		this.rebuild();
	}

	setShowImages(showImages: boolean): void {
		this.options = { ...this.options, showImages };
		this.rebuild();
	}

	override invalidate(): void {
		if (this.imageProtocol !== getCapabilities().images) this.rebuild();
		super.invalidate();
	}

	setImageWidthCells(imageWidthCells: number): void {
		this.options = { ...this.options, imageWidthCells };
		this.rebuild();
	}

	updateBlock(block: ApplicationContentBlock, options = this.options): void {
		this.block = block;
		this.options = options;
		this.rebuild();
	}

	private rebuild(): void {
		this.imageProtocol = getCapabilities().images;
		this.clear();
		const block = this.block;
		if (block.type === "image" && this.options.showImages !== false && getCapabilities().images) {
			const key = JSON.stringify([
				block.asset.id,
				block.asset.revision,
				block.asset.mimeType,
				block.asset.name,
				this.options.imageWidthCells ?? 60,
			]);
			if (this.imageKey !== key || !this.image || this.imageReader !== this.options.readAsset) {
				const payload = this.options.readAsset?.(block.asset.id);
				if (payload?.encoding === "base64") {
					this.imageKey = key;
					this.imageReader = this.options.readAsset;
					this.image = new Image(
						payload.data,
						block.asset.mimeType,
						{ fallbackColor: (text) => theme.fg("dim", sanitizeTerminalText(text)) },
						{
							maxWidthCells: this.options.imageWidthCells ?? 60,
							filename: block.asset.name,
						},
					);
				} else {
					this.imageKey = undefined;
					this.imageReader = undefined;
					this.image = undefined;
				}
			}
			if (this.image) {
				this.addChild(this.image);
				if (block.asset.mimeType !== "image/png" && this.imageProtocol === "kitty" && !this.pngTranscoderRequested) {
					this.pngTranscoderRequested = true;
					ensurePngTranscoder(() => {
						this.image?.invalidate();
						this.options.requestRender?.();
					});
				}
				return;
			}
		}
		const text =
			block.type === "image"
				? `[Image attachment: ${block.asset.name ?? block.asset.mimeType}, ${block.asset.size} bytes]`
				: contentText(block, this.options.readAsset);
		this.addChild(new Text(theme.fg("dim", sanitizeTerminalText(text)), 1, 0));
	}
}

/** Custom tool renderers retain their established model-facing input shape. */
export function toolContent(
	content: readonly ApplicationContentBlock[],
	readAsset?: AssetReader,
): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
	return content.map((block) => {
		if (block.type === "image") {
			const payload = readAsset?.(block.asset.id);
			if (payload?.encoding === "base64") return { type: "image", data: payload.data, mimeType: block.asset.mimeType };
		}
		return { type: "text", text: contentText(block, readAsset) };
	});
}
