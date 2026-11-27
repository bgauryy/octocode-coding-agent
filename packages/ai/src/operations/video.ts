import type { CallOptions, OperationClientConfig } from "./config.ts";
import { OperationError } from "./errors.ts";
import { asRecord, asString, optNumber, optString, perform, requireId, requireNonEmpty } from "./http.ts";

export type VideoStatus = "queued" | "in_progress" | "completed" | "failed";

export interface VideoRequest {
	model: string;
	prompt: string;
	/** Clip length in seconds, e.g. "4", "8", "12" (provider-defined). */
	seconds?: string;
	/** `WIDTHxHEIGHT`, e.g. "1280x720". */
	size?: string;
}

export interface VideoJob {
	id: string;
	status: VideoStatus;
	model?: string;
	progress?: number;
	createdAt?: number;
	completedAt?: number;
	error?: { code?: string; message: string };
}

const STATUSES = new Set<string>(["queued", "in_progress", "completed", "failed"]);

function parseJob(raw: unknown, op: string): VideoJob {
	const r = asRecord(raw, op, "video");
	const status = asString(r.status, op, "status");
	if (!STATUSES.has(status))
		throw new OperationError("malformed_response", op, `unknown status "${status.slice(0, 40)}"`);
	const err = r.error === null || r.error === undefined ? undefined : asRecord(r.error, op, "error");
	return {
		id: asString(r.id, op, "id"),
		status: status as VideoStatus,
		model: optString(r.model),
		progress: optNumber(r.progress),
		createdAt: optNumber(r.created_at),
		completedAt: optNumber(r.completed_at),
		error: err ? { code: optString(err.code), message: optString(err.message) ?? "unknown error" } : undefined,
	};
}

/** OpenAI-compatible `POST {baseUrl}/videos`; returns the queued job (text-to-video; no input reference). */
export async function createVideo(
	config: OperationClientConfig,
	request: VideoRequest,
	options?: CallOptions,
): Promise<VideoJob> {
	const op = "video.create";
	requireNonEmpty(request.model, op, "model");
	requireNonEmpty(request.prompt, op, "prompt");
	if (request.size !== undefined && !/^\d{2,5}x\d{2,5}$/.test(request.size)) {
		throw new OperationError("invalid_input", op, "size must look like 1280x720");
	}
	const { body } = await perform(
		config,
		{
			operation: op,
			method: "POST",
			path: "videos",
			json: {
				model: request.model,
				prompt: request.prompt,
				...(request.seconds === undefined ? {} : { seconds: request.seconds }),
				...(request.size === undefined ? {} : { size: request.size }),
			},
		},
		"json",
		options,
	);
	return parseJob(body, op);
}

/** `GET /videos/{id}`. */
export async function getVideoStatus(
	config: OperationClientConfig,
	id: string,
	options?: CallOptions,
): Promise<VideoJob> {
	const op = "video.status";
	const { body } = await perform(
		config,
		{ operation: op, method: "GET", path: `videos/${requireId(id, op)}` },
		"json",
		options,
	);
	return parseJob(body, op);
}

export interface WaitForVideoOptions extends CallOptions {
	/** Delay between polls. Default 5000 ms. */
	intervalMs?: number;
	/** Give up after this long. Default 10 minutes. */
	maxWaitMs?: number;
	onStatus?: (job: VideoJob) => void;
	/** Injectable delay (tests); must reject when the signal aborts. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new OperationError("aborted", "video.wait", "aborted"));
		const onAbort = () => {
			clearTimeout(timer);
			reject(new OperationError("aborted", "video.wait", "aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Polls until the job completes. Throws `job_failed` on a failed job and `timeout` past maxWaitMs. */
export async function waitForVideo(
	config: OperationClientConfig,
	id: string,
	opts: WaitForVideoOptions = {},
): Promise<VideoJob> {
	const interval = opts.intervalMs ?? 5000;
	const maxWait = opts.maxWaitMs ?? 600_000;
	const sleep = opts.sleep ?? abortableSleep;
	let waited = 0;
	for (;;) {
		const job = await getVideoStatus(config, id, opts);
		opts.onStatus?.(job);
		if (job.status === "completed") return job;
		if (job.status === "failed") {
			throw new OperationError(
				"job_failed",
				"video.wait",
				`video ${job.id} failed: ${job.error?.message ?? "unknown error"}`,
			);
		}
		if (waited + interval > maxWait)
			throw new OperationError("timeout", "video.wait", `not complete after ${maxWait} ms`);
		await sleep(interval, opts.signal);
		waited += interval;
	}
}

export type VideoVariant = "video" | "thumbnail" | "spritesheet";

/** `GET /videos/{id}/content?variant=…`; bytes bounded by maxResponseBytes (raise it for real clips). */
export async function downloadVideo(
	config: OperationClientConfig,
	id: string,
	variant: VideoVariant = "video",
	options?: CallOptions,
): Promise<{ data: Uint8Array; contentType: string | undefined }> {
	const op = "video.content";
	const { body, headers } = await perform(
		config,
		{ operation: op, method: "GET", path: `videos/${requireId(id, op)}/content`, query: { variant } },
		"bytes",
		options,
	);
	if (body.byteLength === 0) throw new OperationError("malformed_response", op, "empty content");
	return { data: body, contentType: headers.get("content-type") ?? undefined };
}

/** `DELETE /videos/{id}`. */
export async function deleteVideo(
	config: OperationClientConfig,
	id: string,
	options?: CallOptions,
): Promise<{ id: string }> {
	const op = "video.delete";
	const { body } = await perform(
		config,
		{ operation: op, method: "DELETE", path: `videos/${requireId(id, op)}` },
		"json",
		options,
	);
	const root = asRecord(body, op, "response");
	if (root.deleted !== true) throw new OperationError("malformed_response", op, "server did not confirm deletion");
	return { id: asString(root.id, op, "id") };
}
