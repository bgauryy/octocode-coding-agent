/** `--no-input` (or a non-empty `OCTOCODE_NO_INPUT`): no prompt may wait for an answer. */
const NO_INPUT_ENV = "OCTOCODE_NO_INPUT";

/** Exports `--no-input` so every prompt in this process and in the processes it starts fails fast. */
export function applyNoInput(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
	if (argv.includes("--no-input")) env[NO_INPUT_ENV] = "1";
}

export function isInputDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env[NO_INPUT_ENV]);
}

/** Thrown in place of a prompt when input is disabled. */
export class NoInputError extends Error {
	constructor(question: string) {
		super(
			`Cannot ask "${question}": input is disabled (--no-input). Answer it with a flag, a setting or the environment.`,
		);
		this.name = "NoInputError";
	}
}

/** Call before showing a prompt: throws `NoInputError` instead of waiting for an answer under `--no-input`. */
export function requireInput(question: string, env: NodeJS.ProcessEnv = process.env): void {
	if (isInputDisabled(env)) throw new NoInputError(question);
}
