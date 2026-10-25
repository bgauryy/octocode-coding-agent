import type { AnyModel, Message } from "../types.ts";

type ImageInputModel = Pick<AnyModel, "provider" | "id" | "input" | "inputLimits">;

export function assertImageInputSupported(
	model: ImageInputModel | undefined,
	content: readonly { type: string }[],
): void {
	if (!content.some((part) => part.type === "image")) return;
	if (!model) throw new Error("Select a model that accepts images before sending an image.");
	if (!model.input.includes("image")) {
		throw new Error(
			`${model.provider}/${model.id} is not configured to accept images. Select an image-capable model or remove the attachment. For a verified custom model, set input to ["text", "image"] in models.json.`,
		);
	}
}

/** Reject unprocessed user images; older turns remain eligible for text-only history replay. */
export function assertPendingImageInputSupported(model: ImageInputModel, messages: readonly Message[]): void {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") break;
		if (message.role === "user" && Array.isArray(message.content)) assertImageInputSupported(model, message.content);
	}
}

export function assertImageRequestContext(model: ImageInputModel, messages: readonly Message[]): void {
	assertPendingImageInputSupported(model, messages);
	if (!model.input.includes("image")) return;
	assertImageCounts(
		model,
		messages.map((message) =>
			(message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
				? message.content.filter((part) => part.type === "image").length
				: 0,
		),
	);
}

export function assertImageCounts(model: ImageInputModel, counts: readonly number[]): void {
	const limits = model.inputLimits?.images;
	if (!limits) return;
	const name = `${model.provider}/${model.id}`;
	const perMessage = limits.maxPerMessage;
	if (perMessage !== undefined && counts.some((count) => count > perMessage)) {
		throw new Error(`${name} accepts at most ${perMessage} images per message. Remove some images and retry.`);
	}
	const total = counts.reduce((sum, count) => sum + count, 0);
	if (limits.maxPerRequest !== undefined && total > limits.maxPerRequest) {
		throw new Error(
			`${name} accepts at most ${limits.maxPerRequest} images per request; this request contains ${total}, including history and tool results. Remove images or start a new session.`,
		);
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Follow content containers only, so tool schemas, tool JSON and quoted text cannot look like attachments. */
function countImages(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((count, part) => count + countImages(part), 0);
	const part = object(value);
	if (!part) return 0;
	if (part.type === "image" || part.type === "image_url" || part.type === "input_image" || part.image) return 1;
	const media = object(part.inlineData ?? part.fileData);
	if (typeof media?.mimeType === "string" && media.mimeType.startsWith("image/")) return 1;
	return [part.content, part.parts, part.output, part.toolResult, part.functionResponse].reduce<number>(
		(count, child) => count + countImages(child),
		0,
	);
}

/** Check the final provider payload after onPayload, including merged tool results and historical images. */
export function assertImageRequestPayload(model: ImageInputModel, payload: unknown): void {
	const limits = model.inputLimits;
	const request = object(payload);
	const messages = request?.messages ?? request?.input ?? request?.contents;
	if (Array.isArray(messages)) {
		const counts = messages.map(countImages);
		if (counts.some((count) => count > 0)) assertImageInputSupported(model, [{ type: "image" }]);
		assertImageCounts(model, counts);
	}
	if (limits?.maxRequestBytes !== undefined) {
		// Bedrock's SDK serializes binary image sources as base64 strings.
		const serialized = JSON.stringify(payload, (_key, value: unknown) =>
			value instanceof Uint8Array ? "A".repeat(4 * Math.ceil(value.byteLength / 3)) : value,
		);
		const bytes = new TextEncoder().encode(serialized).byteLength;
		if (bytes > limits.maxRequestBytes) {
			throw new Error(
				`${model.provider}/${model.id} accepts a request payload of at most ${limits.maxRequestBytes} bytes; this payload is ${bytes} bytes. Reduce attachments or start a new session.`,
			);
		}
	}
}
