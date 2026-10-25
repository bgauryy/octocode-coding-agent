import { type ContentBlock, RequestError } from "@agentclientprotocol/sdk";
import type { ImageContent } from "@octocodeai/octocode-ai";
import { detectSupportedImageMimeType } from "../../../coding-agent/src/utils/mime.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 20;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function invalid(message: string): never {
	throw RequestError.invalidParams({ message });
}

function image(block: Extract<ContentBlock, { type: "image" }>): ImageContent {
	if (!IMAGE_TYPES.has(block.mimeType)) invalid("ACP images must be PNG, JPEG, GIF or WebP.");
	if (typeof block.data !== "string" || block.data.length === 0) invalid("ACP image data must be non-empty base64.");
	// Bound allocation before decoding. Buffer's base64 decoder alone accepts malformed input.
	if (block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) invalid("ACP images may not exceed 5 MiB each.");
	if (block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
		invalid("ACP image data is not valid padded base64.");
	}
	const bytes = Buffer.from(block.data, "base64");
	if (bytes.length > MAX_IMAGE_BYTES) invalid("ACP images may not exceed 5 MiB each.");
	if (bytes.toString("base64") !== block.data || detectSupportedImageMimeType(bytes) !== block.mimeType) {
		invalid("ACP image data does not match its declared image type.");
	}
	return { type: "image", data: block.data, mimeType: block.mimeType };
}

/** Convert stable ACP prompt blocks without fetching linked resources or decoding embedded binary resources. */
export function convertPrompt(prompt: ContentBlock[]): { text: string; images?: ImageContent[] } {
	if (!Array.isArray(prompt)) invalid("ACP prompt must be an array of content blocks.");
	const text: string[] = [];
	const images: ImageContent[] = [];
	let imageBytes = 0;
	for (const block of prompt) {
		if (!block || typeof block !== "object") invalid("Invalid ACP content block.");
		switch (block.type) {
			case "text":
				if (typeof block.text !== "string") invalid("ACP text content must be a string.");
				text.push(block.text);
				break;
			case "image": {
				if (images.length >= MAX_IMAGES) invalid("An ACP prompt may contain at most 20 images.");
				const converted = image(block);
				imageBytes += Buffer.byteLength(converted.data, "base64");
				if (imageBytes > MAX_PROMPT_IMAGE_BYTES) invalid("ACP prompt images may not exceed 20 MiB in total.");
				images.push(converted);
				break;
			}
			case "resource_link":
				if (typeof block.uri !== "string" || typeof block.name !== "string") invalid("Invalid ACP resource link.");
				text.push(`[Resource link: ${block.title || block.name}]\nURI: ${block.uri}`);
				break;
			case "resource": {
				const resource = block.resource;
				if (!resource || typeof resource !== "object" || "blob" in resource || !("text" in resource)) {
					invalid("ACP embedded context supports text resources only; binary resources are unsupported.");
				}
				if (typeof resource.uri !== "string" || typeof resource.text !== "string")
					invalid("Invalid ACP text resource.");
				text.push(`[Embedded resource: ${resource.uri}]\n${resource.text}`);
				break;
			}
			default:
				invalid("Unsupported ACP content type. Supported: text, image, resource_link and embedded text resource.");
		}
	}
	return { text: text.join("\n\n"), ...(images.length ? { images } : {}) };
}
