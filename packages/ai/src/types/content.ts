export type { ContentAnnotation } from "@octocodeai/octocode-contracts";

/** Generated binary content other than an image. Consumers choose a supported presentation. */
export interface MediaContent {
	type: "media";
	mimeType: string;
	data?: string;
	uri?: string;
	name?: string;
	thoughtSignature?: string;
}

/** A provider reference whose bytes are not embedded in the response. */
export interface ResourceContent {
	type: "resource";
	uri: string;
	mimeType?: string;
	name?: string;
	text?: string;
	thoughtSignature?: string;
}

/** Explicit fallback for a provider output that has no supported normalized representation. */
export interface UnsupportedContent {
	type: "unsupported";
	providerType: string;
	text: string;
}
