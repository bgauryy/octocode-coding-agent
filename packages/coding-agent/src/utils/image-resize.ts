import { Worker } from "node:worker_threads";
import { isBundledNode } from "../install/package-detection.ts";
import {
	IMAGE_RESIZE_WORKER_DATA,
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizedImage,
	type ResizeImageWorkerResponse,
	resizeImageInProcess,
} from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

/** How image resizes ran in this process: in a worker, or on the calling thread after a worker could not start. */
export interface ImageResizeStats {
	worker: number;
	inProcess: number;
	/** Total and longest time of the resizes run on the calling thread, in milliseconds. */
	inProcessMs: number;
	inProcessMaxMs: number;
	/** Images too large to resize on the calling thread (`IN_PROCESS_RESIZE_LIMIT`), omitted instead. */
	inProcessRefused: number;
	/** Why the latest worker attempt failed. */
	lastWorkerError?: string;
}

/**
 * The largest encoded image resized on the calling thread when no worker can: decoding one larger blocks input and
 * rendering for seconds. A larger image is omitted as one that cannot be resized.
 */
export const IN_PROCESS_RESIZE_LIMIT = 8 * 1024 * 1024;

const stats: ImageResizeStats = { worker: 0, inProcess: 0, inProcessMs: 0, inProcessMaxMs: 0, inProcessRefused: 0 };

/** A copy of this process's resize counts, for status and diagnostics. */
export function imageResizeStats(): ImageResizeStats {
	return { ...stats, inProcessMs: Math.round(stats.inProcessMs), inProcessMaxMs: Math.round(stats.inProcessMaxMs) };
}

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer detaches the buffer, so transfer a worker-owned copy and leave the
	// caller's bytes intact.
	return new Uint8Array(input);
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return (
		value !== null && typeof value === "object" && "type" in value && value.type === IMAGE_RESIZE_WORKER_RESPONSE_TYPE
	);
}

function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier, isBundledNode ? { workerData: IMAGE_RESIZE_WORKER_DATA } : undefined);
}

async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const worker = createResizeWorker(workerSpecifier);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ResizedImage | null>((resolve, reject) => {
			let settled = false;
			const settle = (result: ResizedImage | null): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			worker.on("message", (message: unknown) => {
				// Ignore messages Node posts on the worker channel itself, such as
				// `{ "watch:require": [...] }` under `node --watch` (nodejs/node#65044).
				if (!isResizeImageWorkerResponse(message)) return;
				if ("error" in message) fail(new Error(message.error));
				else settle(message.result);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		void worker.terminate().catch(() => undefined);
	}
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Runs Photon in a worker thread so WASM decoding, resizing, and encoding do not
 * block the TUI event loop. If the worker cannot be loaded (for example in some
 * Bun compiled executable layouts), fall back to in-process resizing so image
 * reads still work.
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	// The Node bundle is one file, so its worker is that file again (`bundle.ts` starts the worker from `workerData`).
	const workerUrl = isBundledNode
		? new URL(import.meta.url)
		: new URL(isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js", import.meta.url);

	// Bun compiled executables resolve worker entrypoints by string path, not via
	// new URL(..., import.meta.url). Try the string path first under Bun so the
	// release binary uses the embedded worker instead of falling back in-process.
	// (`scripts/build/compile-binary.mjs` embeds it at this path under the package folder.)
	if (typeof process.versions.bun === "string") {
		try {
			const result = await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
			stats.worker += 1;
			return result;
		} catch {
			// Not a compiled executable with an embedded worker: try the URL worker below.
		}
	}

	try {
		const result = await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
		stats.worker += 1;
		return result;
	} catch (error) {
		stats.lastWorkerError = error instanceof Error ? error.message : String(error);
		if (inputBytes.byteLength > IN_PROCESS_RESIZE_LIMIT) {
			stats.inProcessRefused += 1;
			return null;
		}
		// The fallback blocks the calling thread for the whole decode and encode: counted and timed so it shows.
		const started = performance.now();
		try {
			return await resizeImageInProcess(inputBytes, mimeType, options);
		} finally {
			const took = performance.now() - started;
			stats.inProcess += 1;
			stats.inProcessMs += took;
			stats.inProcessMaxMs = Math.max(stats.inProcessMaxMs, took);
		}
	}
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
