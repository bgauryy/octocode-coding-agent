import {
	applicationMessageText,
	previewText,
	type ApplicationContentBlock,
	type ApplicationMessage,
	type ApplicationTool,
	type ApplicationToolProgress,
	type ContentAnnotation,
} from "@octocodeai/octocode-contracts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import {
	DISPLAY_OUTPUT_MAX_BYTES,
	outputFileReadable,
	readOutputFile,
	readOutputFileEnds,
} from "../../utils/output-files.ts";
import { compactionSummaryDisplay } from "../messages.ts";
import type { ApplicationAssets } from "./assets.ts";
import { rememberJsonLength } from "@octocodeai/octocode-common/json-length";

const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
/** Public display values must not retain references to provider objects mutated by later stream chunks. */
export function cloneDisplay<T>(value: T): T {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
/** `cloneDisplay` that keeps the clone's serialized length, for a value later compared with a size limit. */
export function cloneMeasured<T>(value: T): T {
	if (value === undefined) return value;
	const json = JSON.stringify(value);
	return rememberJsonLength(JSON.parse(json) as T, json.length);
}

function preview(
	text: string,
	assets: ApplicationAssets,
	slot?: string,
): { text: string; full?: ReturnType<ApplicationAssets["put"]> } {
	const shown = previewText(text);
	return shown.previewed
		? { text: shown.text, full: assets.put(text, "text/plain", "utf8", undefined, slot) }
		: { text };
}

export function annotations(value: unknown): ContentAnnotation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item) => {
		const source = asRecord(item);
		if (typeof source.type !== "string") return [];
		const annotation: ContentAnnotation = { type: source.type };
		for (const key of ["title", "url", "text", "fileId"] as const)
			if (typeof source[key] === "string") annotation[key] = source[key];
		for (const key of ["startIndex", "endIndex", "documentIndex", "startPage", "endPage"] as const)
			if (typeof source[key] === "number" && Number.isFinite(source[key])) annotation[key] = source[key];
		return [annotation];
	});
}

/** Normalize display data once. Signatures and provider continuation payloads never enter this contract. */
export function normalizeApplicationContent(
	value: unknown,
	owner: string,
	assets: ApplicationAssets,
	streaming = false,
): ApplicationContentBlock[] {
	const blocks = typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : [];
	return blocks.map((value, index): ApplicationContentBlock => {
		const block = asRecord(value);
		const id = `${owner}:${index}`;
		const slot = streaming ? id : undefined;
		switch (block.type) {
			case "text": {
				const marks = annotations(block.annotations);
				return {
					id,
					type: "text",
					...preview(string(block.text) ?? "", assets, slot),
					...(marks ? { annotations: marks } : {}),
				};
			}
			case "thinking":
				return {
					id,
					type: "thinking",
					...preview(string(block.thinking) ?? "", assets, slot),
					...(block.redacted === true ? { redacted: true } : {}),
				};
			case "image":
				if (typeof block.data === "string" && typeof block.mimeType === "string")
					return {
						id,
						type: "image",
						asset: assets.put(block.data, block.mimeType, "base64", string(block.name), slot),
					};
				return { id, type: "unsupported", providerType: "image", text: "Image data unavailable" };
			case "media":
				return {
					id,
					type: "media",
					mimeType: string(block.mimeType) ?? "application/octet-stream",
					...(typeof block.data === "string"
						? {
								asset: assets.put(
									block.data,
									string(block.mimeType) ?? "application/octet-stream",
									"base64",
									string(block.name),
									slot,
								),
							}
						: {}),
					...(typeof block.uri === "string" ? { uri: block.uri } : {}),
					...(typeof block.name === "string" ? { name: block.name } : {}),
				};
			case "resource":
				return {
					id,
					type: "resource",
					uri: string(block.uri) ?? "",
					...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
					...(typeof block.name === "string" ? { name: block.name } : {}),
					...(typeof block.text === "string" ? preview(block.text, assets, slot) : {}),
				};
			case "toolCall":
				return {
					id,
					type: "toolCall",
					toolCallId: string(block.id) ?? id,
					name: string(block.name) ?? "unknown",
					arguments: cloneDisplay(block.arguments ?? {}),
				};
			default:
				return {
					id,
					type: "unsupported",
					providerType: string(block.providerType) ?? string(block.type) ?? "unknown",
					...preview(string(block.text) ?? `Unsupported content: ${string(block.type) ?? "unknown"}`, assets, slot),
				};
		}
	});
}

/** Each end of a spilled shell output a projection reads; a longer output's middle is read only by a view that asks. */
const SHELL_END_BYTES = 64 * 1024;

/** A shell output's displayed text, and for a long spill the file a view reads it whole from, with its size. */
type ShellOutput = { text: string; file?: { path: string; size: number } };

/**
 * The complete output of a truncated user shell command: what an older session recorded, else this process's own spill.
 * A path from a transcript grants no read authority (`readOutputFile`), so after a restart only the trimmed output shows.
 * A long spill (up to `DISPLAY_OUTPUT_MAX_BYTES`) is shown by its ends, read in bounded parts: `previewText` of the
 * whole needs only its first and last characters, and the whole stays in the file for a view that reads it.
 */
function completeShellOutput(source: Record<string, unknown>): ShellOutput | undefined {
	const recorded = string(source.fullOutput);
	if (recorded !== undefined || source.truncated !== true)
		return recorded === undefined ? undefined : { text: recorded };
	const file = string(source.fullOutputPath);
	try {
		if (!file || !outputFileReadable(file, DISPLAY_OUTPUT_MAX_BYTES)) return undefined;
		const ends = readOutputFileEnds(file, SHELL_END_BYTES, SHELL_END_BYTES);
		if (!ends) return undefined;
		const head = ends.head.replace(/\r/g, "");
		const tail = ends.tail.replace(/\r/g, "");
		if (!tail) return { text: head };
		const shown = previewText(head + tail);
		// Ends long enough to hold the preview's parts give the preview of the whole; otherwise read it whole.
		if (head.length >= PREVIEW_PART_CHARS && tail.length >= PREVIEW_PART_CHARS && shown.previewed)
			return { text: shown.text, file: { path: file, size: ends.size } };
		const whole = readOutputFile(file, DISPLAY_OUTPUT_MAX_BYTES)?.replace(/\r/g, "");
		return whole === undefined ? undefined : { text: whole };
	} catch {
		return undefined;
	}
}

/** More than either part `previewText` keeps of a long text's start and end. */
const PREVIEW_PART_CHARS = 2000;

export function normalizeApplicationMessage(value: unknown, id: string, assets: ApplicationAssets): ApplicationMessage {
	const source = asRecord(value);
	const fullOutput = source.role === "bashExecution" ? completeShellOutput(source) : undefined;
	const bashContent =
		source.role === "bashExecution"
			? [
					{ type: "text", text: `$ ${string(source.command) ?? ""}` },
					{ type: "text", text: fullOutput?.text ?? string(source.output) ?? "" },
					...(source.truncated === true && fullOutput === undefined
						? [
								{
									type: "unsupported",
									providerType: "shell-output-unavailable",
									text:
										string(source.fullOutputUnavailable) ??
										(string(source.fullOutputPath)
											? `The displayed output is truncated; the full output was saved at ${string(source.fullOutputPath)}`
											: "Full shell output is unavailable; the displayed output is truncated"),
								},
							]
						: []),
				]
			: undefined;
	// A compaction summary is written for the model: the web view shows what the terminal does.
	const compactionContent =
		source.role === "compactionSummary" && typeof source.summary === "string"
			? compactionSummaryDisplay({
					summary: source.summary,
					tokensBefore: typeof source.tokensBefore === "number" ? source.tokensBefore : 0,
				})
			: undefined;
	const content = normalizeApplicationContent(
		bashContent ?? compactionContent ?? source.content ?? source.summary ?? source.output,
		id,
		assets,
		source.stopReason === "pending",
	);
	// The output block of a long spill already holds the preview; its whole text is read from the file when asked for.
	const spill = fullOutput?.file;
	if (spill && content[1]?.type === "text")
		content[1] = { ...content[1], full: assets.putOutputFile(spill.path, spill.size, `${id}:shell-output`) };
	const stopReason = string(source.stopReason);
	const complete = stopReason !== "pending";
	const message: ApplicationMessage = {
		id,
		role: string(source.role) ?? "custom",
		content,
		text: applicationMessageText(content),
		complete,
		status: !complete
			? "streaming"
			: stopReason === "aborted" || (source.role === "bashExecution" && source.cancelled === true)
				? "aborted"
				: stopReason === "error" ||
					  source.isError === true ||
					  (source.role === "bashExecution" && typeof source.exitCode === "number" && source.exitCode !== 0)
					? "failed"
					: stopReason === "length"
						? "interrupted"
						: "completed",
	};
	applyMessageFields(source, message);
	const serialized = JSON.stringify(message);
	if (serialized.length > 60000) {
		// The slim form keeps the small identity fields views place and label the message by (a tool result's
		// `toolCallId` attaches it to its tool row); the large ones live in the asset.
		const { provider, model, responseId, stopReason, toolCallId, customType, timestamp, durationMs } = message;
		const identity = { provider, model, responseId, stopReason, toolCallId, customType, timestamp, durationMs };
		return {
			id,
			role: message.role,
			complete,
			status: message.status,
			display: message.display,
			...Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)),
			...(message.errorMessage !== undefined && message.errorMessage.length <= 1000
				? { errorMessage: message.errorMessage }
				: {}),
			text: "[Full message available]",
			content: [
				{ id: `${id}:full`, type: "unsupported", providerType: "large-message", text: "Full message available" },
			],
			full: assets.put(
				serialized,
				"application/json",
				"utf8",
				undefined,
				source.stopReason === "pending" ? `${id}:full` : undefined,
			),
		};
	}
	return message;
}

/** Copy the fields a message shows besides its content and status from its source. */
export function applyMessageFields(source: Record<string, unknown>, message: ApplicationMessage): void {
	for (const key of [
		"provider",
		"model",
		"responseId",
		"stopReason",
		"errorMessage",
		"toolCallId",
		"customType",
	] as const)
		if (typeof source[key] === "string") message[key] = source[key];
	for (const key of ["timestamp", "durationMs"] as const)
		if (typeof source[key] === "number" && Number.isFinite(source[key])) message[key] = source[key];
	if (source.usage && typeof source.usage === "object") message.usage = cloneDisplay(asRecord(source.usage));
	if (source.details !== undefined) message.details = cloneDisplay(source.details);
	const detailKeys =
		source.role === "bashExecution"
			? [
					"command",
					"exitCode",
					"cancelled",
					"truncated",
					"excludeFromContext",
					"fullOutputPath",
					"fullOutputUnavailable",
				]
			: source.role === "branchSummary"
				? ["fromId"]
				: source.role === "compactionSummary"
					? ["tokensBefore"]
					: [];
	if (detailKeys.length)
		message.details = cloneDisplay(
			Object.fromEntries(detailKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
		);
	if (source.role === "custom" || source.role === "system")
		message.display = source.role === "custom" && source.display === true;
}

/** Keep structured output readable without putting unbounded JSON in every streamed frame. */
/** A tool's reported progress in its displayed form; undefined unless `progress` is a finite, non-negative number. */
function toolProgress(value: unknown): ApplicationToolProgress | undefined {
	const source = asRecord(value);
	const valid = (number: unknown): number is number =>
		typeof number === "number" && Number.isFinite(number) && number >= 0;
	if (!valid(source.progress)) return undefined;
	return {
		progress: source.progress,
		...(valid(source.total) ? { total: source.total } : {}),
		...(typeof source.message === "string" && source.message ? { message: source.message.slice(0, 1000) } : {}),
	};
}

export function normalizeToolData(
	value: unknown,
	id: string,
	assets: ApplicationAssets,
	streaming = false,
): Partial<ApplicationTool> {
	const source = asRecord(value);
	const data: Partial<ApplicationTool> = {
		content: normalizeApplicationContent(source.content, id, assets, streaming),
	};
	// Each value is serialized once: the text that clones it also measures it and, when large, is the asset.
	const structured: string[] = [];
	for (const key of ["structuredContent", "details"] as const)
		if (source[key] !== undefined) {
			const json = JSON.stringify(source[key]);
			data[key] = rememberJsonLength(JSON.parse(json), json.length);
			structured.push(`"${key}":${json}`);
		}
	if (source.usage && typeof source.usage === "object") data.usage = cloneMeasured(asRecord(source.usage));
	if (typeof source.durationMs === "number") data.durationMs = source.durationMs;
	const progress = toolProgress(source.progress);
	if (progress) data.progress = progress;
	const length = structured.reduce((sum, member) => sum + member.length, 2 + Math.max(0, structured.length - 1));
	if (length > 8000) {
		data.full = assets.put(
			`{${structured.join(",")}}`,
			"application/json",
			"utf8",
			undefined,
			streaming ? `${id}:data` : undefined,
		);
		delete data.structuredContent;
		delete data.details;
	}
	return data;
}
