import { Type, type Static } from "typebox";

/** Public source references; opaque provider continuation tokens are deliberately not display data. */
export const ContentAnnotationSchema = Type.Object({
	type: Type.String(),
	title: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	startIndex: Type.Optional(Type.Number()),
	endIndex: Type.Optional(Type.Number()),
	fileId: Type.Optional(Type.String()),
	documentIndex: Type.Optional(Type.Number()),
	startPage: Type.Optional(Type.Number()),
	endPage: Type.Optional(Type.Number()),
});
export type ContentAnnotation = Static<typeof ContentAnnotationSchema>;

/** An opaque, session-scoped reference. Consumers never receive host filesystem authority. */
export const ApplicationAssetSchema = Type.Object({
	id: Type.String(),
	mimeType: Type.String(),
	size: Type.Integer({ minimum: 0 }),
	/** Changes when a streaming asset's current value is replaced. Final assets are immutable. */
	revision: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
});
export type ApplicationAsset = Static<typeof ApplicationAssetSchema>;
export interface ApplicationAssetPayload {
	asset: ApplicationAsset;
	encoding: "base64" | "utf8";
	data: string;
}
export interface ApplicationAssetInput {
	mimeType: string;
	data: string;
	name?: string;
}
export const APPLICATION_UPLOAD_BYTES = 20 * 1024 * 1024;
export const APPLICATION_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ApplicationAssetInputSchema = Type.Object(
	{
		mimeType: Type.Union(APPLICATION_IMAGE_MIME_TYPES.map((mime) => Type.Literal(mime))),
		data: Type.String({ minLength: 1, maxLength: Math.ceil(APPLICATION_UPLOAD_BYTES / 3) * 4 }),
		name: Type.Optional(Type.String({ maxLength: 255 })),
	},
	{ additionalProperties: false },
);

const id = { id: Type.String() };
const expandedText = {
	text: Type.String(),
	/** Present when text is a preview; fetch this asset to read all of it. */
	full: Type.Optional(ApplicationAssetSchema),
};
export const ApplicationContentBlockSchema = Type.Union([
	Type.Object({
		...id,
		type: Type.Literal("text"),
		...expandedText,
		annotations: Type.Optional(Type.Array(ContentAnnotationSchema)),
	}),
	Type.Object({ ...id, type: Type.Literal("thinking"), ...expandedText, redacted: Type.Optional(Type.Boolean()) }),
	Type.Object({ ...id, type: Type.Literal("image"), asset: ApplicationAssetSchema }),
	Type.Object({
		...id,
		type: Type.Literal("media"),
		mimeType: Type.String(),
		asset: Type.Optional(ApplicationAssetSchema),
		uri: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	}),
	Type.Object({
		...id,
		type: Type.Literal("resource"),
		uri: Type.String(),
		mimeType: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		full: Type.Optional(ApplicationAssetSchema),
	}),
	Type.Object({
		...id,
		type: Type.Literal("toolCall"),
		toolCallId: Type.String(),
		name: Type.String(),
		arguments: Type.Unknown(),
	}),
	Type.Object({ ...id, type: Type.Literal("unsupported"), providerType: Type.String(), ...expandedText }),
]);
export type ApplicationContentBlock = Static<typeof ApplicationContentBlockSchema>;

/** Text-only consumers get an explicit description for every non-text block. */
export function applicationContentText(content: readonly ApplicationContentBlock[]): string {
	return content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return block.redacted ? "[Reasoning redacted]" : block.text;
				case "image":
					return `[Image: ${block.asset.name ?? block.asset.mimeType}]`;
				case "media":
					return `[Media: ${block.name ?? block.mimeType}]`;
				case "resource":
					return block.text || `[Resource: ${block.name ?? block.uri}]`;
				case "toolCall":
					return `[Tool call: ${block.name}]`;
				case "unsupported":
					return block.text || `[Unsupported content: ${block.providerType}]`;
			}
		})
		.join("\n");
}
