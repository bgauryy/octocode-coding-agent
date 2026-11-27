import type { CallOptions, OperationClientConfig } from "./config.ts";
import { OperationError } from "./errors.ts";
import { asRecord, asString, perform, requireNonEmpty } from "./http.ts";
import { appendFile, type UploadFile } from "./upload.ts";

/** OpenAI documents a 25 MB upload cap for transcription. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

export type TranscriptionFormat = "json" | "verbose_json" | "text" | "srt" | "vtt";

export interface TranscriptionRequest {
	model: string;
	file: UploadFile;
	language?: string;
	prompt?: string;
	temperature?: number;
	/** Default `json`. */
	responseFormat?: TranscriptionFormat;
}

export interface TranscriptionResult {
	text: string;
	format: TranscriptionFormat;
	/** Parsed body for `json`/`verbose_json` (segments, language, duration …). */
	details?: Record<string, unknown>;
}

/** OpenAI-compatible `POST {baseUrl}/audio/transcriptions` (multipart). */
export async function transcribeAudio(
	config: OperationClientConfig,
	request: TranscriptionRequest,
	options?: CallOptions,
): Promise<TranscriptionResult> {
	const op = "audio.transcription";
	requireNonEmpty(request.model, op, "model");
	const format = request.responseFormat ?? "json";
	const form = new FormData();
	appendFile(form, "file", request.file, MAX_TRANSCRIPTION_BYTES, op);
	form.append("model", request.model);
	form.append("response_format", format);
	if (request.language) form.append("language", request.language);
	if (request.prompt) form.append("prompt", request.prompt);
	if (request.temperature !== undefined) {
		if (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 1) {
			throw new OperationError("invalid_input", op, "temperature must be within 0..1");
		}
		form.append("temperature", String(request.temperature));
	}
	const spec = { operation: op, method: "POST", path: "audio/transcriptions", form } as const;
	if (format === "json" || format === "verbose_json") {
		const { body } = await perform(config, spec, "json", options);
		const root = asRecord(body, op, "response");
		return { text: asString(root.text, op, "text"), format, details: root };
	}
	const { body } = await perform(config, spec, "text", options);
	return { text: body, format };
}

export type SpeechFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

export interface SpeechRequest {
	model: string;
	/** Up to 4096 characters. */
	input: string;
	voice: string;
	responseFormat?: SpeechFormat;
	speed?: number;
	instructions?: string;
}

export interface SpeechResult {
	audio: Uint8Array;
	contentType: string | undefined;
	format: SpeechFormat;
}

export const MAX_SPEECH_INPUT_CHARS = 4096;

/** OpenAI-compatible `POST {baseUrl}/audio/speech`; returns the audio bytes (bounded by maxResponseBytes). */
export async function synthesizeSpeech(
	config: OperationClientConfig,
	request: SpeechRequest,
	options?: CallOptions,
): Promise<SpeechResult> {
	const op = "audio.speech";
	requireNonEmpty(request.model, op, "model");
	requireNonEmpty(request.input, op, "input");
	requireNonEmpty(request.voice, op, "voice");
	if (request.input.length > MAX_SPEECH_INPUT_CHARS) {
		throw new OperationError("invalid_input", op, `input exceeds ${MAX_SPEECH_INPUT_CHARS} characters`);
	}
	if (request.speed !== undefined && (!(request.speed >= 0.25) || !(request.speed <= 4))) {
		throw new OperationError("invalid_input", op, "speed must be within 0.25..4");
	}
	const format = request.responseFormat ?? "mp3";
	const { body, headers } = await perform(
		config,
		{
			operation: op,
			method: "POST",
			path: "audio/speech",
			json: {
				model: request.model,
				input: request.input,
				voice: request.voice,
				response_format: format,
				...(request.speed === undefined ? {} : { speed: request.speed }),
				...(request.instructions ? { instructions: request.instructions } : {}),
			},
		},
		"bytes",
		options,
	);
	if (body.byteLength === 0) throw new OperationError("malformed_response", op, "empty audio response");
	const contentType = headers.get("content-type") ?? undefined;
	if (contentType?.includes("json") || contentType?.startsWith("text/")) {
		throw new OperationError("malformed_response", op, `expected audio, got ${contentType}`);
	}
	return { audio: body, contentType, format };
}
