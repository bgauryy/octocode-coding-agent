import * as fs from "node:fs";
import { resolveWriteLogPath } from "./environment.ts";
import type { OutputTelemetry } from "./types.ts";

function emptyTelemetry(): OutputTelemetry {
	return { writtenBytes: 0, writeCalls: 0, maxWriteBytes: 0, backpressuredWrites: 0, maxQueuedBytes: 0 };
}

/**
 * Rendered output to stdout: reports the queue so the render loop can gate frames on it, counts
 * bytes when telemetry is on, and copies output to the write log when `OCTOCODE_TUI_WRITE_LOG` is set.
 */
export class TerminalOutput {
	private decorativePressureThreshold: number | undefined;
	private telemetryEnabled = false;
	private telemetry: OutputTelemetry = emptyTelemetry();
	private readonly writeLogPath = resolveWriteLogPath();

	get pendingBytes(): number {
		return process.stdout.writableLength;
	}

	setDecorativePressureThreshold(bytes: number | undefined): void {
		this.decorativePressureThreshold = bytes;
	}

	/** Whether decorative output, such as progress keepalives, may be written given the queued bytes. */
	allowsDecorativeOutput(): boolean {
		return this.decorativePressureThreshold === undefined || this.pendingBytes <= this.decorativePressureThreshold;
	}

	setTelemetryEnabled(enabled: boolean): void {
		if (enabled && !this.telemetryEnabled) {
			this.telemetry = emptyTelemetry();
		}
		this.telemetryEnabled = enabled;
	}

	getTelemetry(): Readonly<OutputTelemetry> {
		return { ...this.telemetry };
	}

	write(data: string): void {
		const accepted = process.stdout.write(data);
		if (this.telemetryEnabled) {
			const bytes = Buffer.byteLength(data);
			this.telemetry.writtenBytes += bytes;
			this.telemetry.writeCalls++;
			this.telemetry.maxWriteBytes = Math.max(this.telemetry.maxWriteBytes, bytes);
			if (!accepted) this.telemetry.backpressuredWrites++;
			this.telemetry.maxQueuedBytes = Math.max(this.telemetry.maxQueuedBytes, this.pendingBytes);
		}
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}
}
