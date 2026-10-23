import {
	deleteAllKittyImages,
	deleteKittyImage,
	getKittyImagePlacement,
	type ImageProtocol,
} from "../terminal-image.ts";
import {
	MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES,
	MAX_CACHED_OFFSCREEN_KITTY_IMAGES,
	MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES,
} from "./constants.ts";
import type { CachedKittyImage } from "./types.ts";

/** Delete every Kitty image when the terminal speaks the Kitty graphics protocol. */
export function deleteKittyImagesFor(imageProtocol: ImageProtocol): string {
	return imageProtocol === "kitty" ? deleteAllKittyImages() : "";
}

/**
 * Replace re-sent Kitty uploads with placement-only commands and evict offscreen images beyond the cache limits.
 * `uploadedKittyImages` is updated in place, most recently placed last.
 */
export function prepareKittyScreen(
	uploadedKittyImages: Map<number, CachedKittyImage>,
	screen: string[],
): { lines: string[]; evictedImageDeletion: string } {
	const visibleImageIds = new Set<number>();
	const lines = screen.map((line) => {
		const placement = getKittyImagePlacement(line);
		if (!placement) return line;
		visibleImageIds.add(placement.imageId);

		const cachedImage = uploadedKittyImages.get(placement.imageId);
		const nextCachedImage = {
			transmissionGeneration: placement.transmissionGeneration,
			transmissionBytes: placement.transmissionBytes,
			estimatedDecodedBytes: placement.estimatedDecodedBytes,
		};
		if (cachedImage) uploadedKittyImages.delete(placement.imageId);
		uploadedKittyImages.set(placement.imageId, nextCachedImage);

		return cachedImage?.transmissionGeneration === placement.transmissionGeneration ? placement.replacementLine : line;
	});

	let cachedOffscreenImageCount = 0;
	let cachedOffscreenTransmissionBytes = 0;
	let cachedOffscreenDecodedBytes = 0;
	for (const [imageId, cachedImage] of uploadedKittyImages) {
		if (visibleImageIds.has(imageId)) continue;
		cachedOffscreenImageCount += 1;
		cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
		cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
	}

	let evictedImageDeletion = "";
	for (const [imageId, cachedImage] of uploadedKittyImages) {
		if (
			cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
			cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
			cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
		) {
			break;
		}
		if (visibleImageIds.has(imageId)) continue;
		evictedImageDeletion += deleteKittyImage(imageId);
		uploadedKittyImages.delete(imageId);
		cachedOffscreenImageCount -= 1;
		cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
		cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
	}
	return { lines, evictedImageDeletion };
}
