import { dbWriterStats, type DbWriterStats } from "../../../db/src/api.ts";
import { imageResizeStats } from "../utils/image-resize.ts";

const FALLBACK_TEXT: Record<NonNullable<DbWriterStats["fallback"]>, string> = {
	bun: "this build has no worker",
	"start-failed": "its worker could not start",
	"load-failed": "its worker did not load",
	crashed: "its worker crashed too often",
	closed: "closed",
};

function writerText(writer: DbWriterStats): string {
	const name = writer.role === "mirror" ? "transcript writer" : "database writer";
	if (writer.mode === "worker") return `${name} in a worker${writer.pending ? ` (${writer.pending} pending)` : ""}`;
	const ran = writer.inlineRuns
		? `; ${writer.inlineRuns} on this thread, ${writer.inlineMs} ms in all, longest ${writer.inlineMaxMs} ms`
		: "";
	return `${name} on the main thread (${writer.fallback ? FALLBACK_TEXT[writer.fallback] : "inline"}${ran})`;
}

/**
 * One line naming where background work runs: each database writer started in this process and image resizing. Work a
 * worker could not take runs on the main thread, where it delays input and rendering; this line is where that shows.
 */
export function workersLine(): string {
	const parts = dbWriterStats().map(writerText);
	const images = imageResizeStats();
	if (images.inProcess > 0)
		parts.push(
			`image resizing on the main thread ${images.inProcess} time${images.inProcess === 1 ? "" : "s"} (longest ${images.inProcessMaxMs} ms${images.lastWorkerError ? `; worker: ${images.lastWorkerError.slice(0, 80)}` : ""})`,
		);
	else if (images.worker > 0) parts.push("image resizing in a worker");
	return `Workers: ${parts.length ? parts.join("; ") : "none started"}`;
}
