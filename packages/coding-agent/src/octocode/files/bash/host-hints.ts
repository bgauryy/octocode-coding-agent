/** Failures that a host or repository layout gives commands written for another one, each with its working alternative. `platform` limits a quirk to one OS; none means every OS. */
const HOST_QUIRKS: ReadonlyArray<{
	failure: RegExp;
	command?: RegExp;
	platform?: NodeJS.Platform;
	hint: string;
}> = [
	{
		// bash: `/bin/bash: timeout: command not found`, `bash: line 1: timeout: ...`; zsh: `zsh:1: command not found: timeout`.
		failure: /^(?:[\w/.-]+:(?:\d+:)? (?:line \d+: )?)?(?:timeout: command not found|command not found: timeout)$/m,
		platform: "darwin",
		hint: "This host has no GNU `timeout` (macOS): drop it and set this tool's `timeout` parameter (seconds).",
	},
	{
		// BSD sed reads the word after `-i` as the backup suffix, so the script is taken for a file or a label.
		failure: /^sed: \d+: .*(?:undefined label|invalid command code)/m,
		// Any BSD sed script typo gives the same errors; the hint fits only a command that ran `sed -i`.
		command: /\bsed\s(?:[^|;&\n]*\s)?-i(?:\s|$)/,
		platform: "darwin",
		hint: "BSD sed (macOS) needs a suffix after -i: use `sed -i ''`, or edit with the `file` tool.",
	},
	{
		// The coding-agent vitest config is in packages/coding-agent only; from the repo root vitest cannot find it.
		failure: /Cannot resolve entry module vitest\./,
		hint: "`vitest.octocode.config.ts` is only in `packages/coding-agent`, not the repo root: run `cd packages/coding-agent && yarn vitest run --config vitest.octocode.config.ts`.",
	},
];

/** The hint for a failed command's output when it shows one of the known quirks for this platform, else undefined. */
export function hostQuirkHint(
	output: string,
	command: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	return HOST_QUIRKS.find(
		(quirk) =>
			(quirk.platform === undefined || quirk.platform === platform) &&
			quirk.failure.test(output) &&
			(quirk.command?.test(command) ?? true),
	)?.hint;
}
