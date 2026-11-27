import type { ExternalReply } from "@octocodeai/octocode-contracts/external";

/** A prompt that failed after it was sent: the agent may have acted, so the prompt is never replayed. */
export class AcpError extends Error {
	readonly execution = "uncertain";
	readonly partial: ExternalReply;
	readonly stderr: string;
	constructor(message: string, partial: ExternalReply, stderr: string, cause: unknown) {
		super(`${message}; external execution may have occurred. The prompt was not replayed.`, { cause });
		this.partial = partial;
		this.stderr = stderr;

		this.name = "AcpError";
	}
}

/** A prompt refused before anything reached the agent: the model may retry once the cause is gone. */
export class AcpRefusal extends Error {
	readonly execution = "not-sent";
	constructor(message: string) {
		super(message);
		this.name = "AcpRefusal";
	}
}

export function timeoutSignal(timeoutMs: number): AbortSignal {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1)
		throw new Error("ACP timeoutMs must be a positive timer duration.");
	return AbortSignal.timeout(timeoutMs);
}
