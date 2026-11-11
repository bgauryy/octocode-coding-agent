/**
 * A user `!` or `!!` command, the same in every mode: `user_bash` handlers may run it themselves or supply the
 * operations it runs with; otherwise it runs locally. Modes only draw it.
 */

import type { BashResult } from "../bash-executor.ts";
import type { ExtensionRunner } from "../features/index.ts";
import type { BashOperations } from "../tools/bash.ts";

/** A `user_bash` handler threw or returned an invalid result. The runner already reported it; nothing ran. */
export class UserBashHookError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "UserBashHookError";
	}
}

export interface UserBashOptions {
	/** `!!`: the output stays out of the model's context. */
	excludeFromContext?: boolean;
	/** Identifier carried by the command's `bash_execution_update` events. */
	id?: string;
	/** Called just before the command runs here, so a view can show it streaming; not called for a handler's result. */
	onStart?(): void;
	onChunk?(chunk: string): void;
}

/** What the operation needs of the session. */
export interface UserBashHost {
	readonly extensionRunner: Pick<ExtensionRunner, "emitUserBash">;
	readonly sessionManager: { getCwd(): string };
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult>;
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void;
}

/**
 * Runs `command` for the user and records its result. Fails closed: when a `user_bash` handler fails, the command does
 * not run and the promise rejects with a {@link UserBashHookError}.
 */
export async function runUserBash(
	host: UserBashHost,
	command: string,
	options: UserBashOptions = {},
): Promise<BashResult> {
	const excludeFromContext = options.excludeFromContext ?? false;
	let hook;
	try {
		hook = await host.extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: host.sessionManager.getCwd(),
		});
	} catch (error) {
		throw new UserBashHookError(error);
	}
	if (hook?.result) {
		host.recordBashResult(command, hook.result, { excludeFromContext });
		return hook.result;
	}
	options.onStart?.();
	return host.executeBash(command, options.onChunk, {
		excludeFromContext,
		...(options.id === undefined ? {} : { id: options.id }),
		...(hook?.operations ? { operations: hook.operations } : {}),
	});
}
