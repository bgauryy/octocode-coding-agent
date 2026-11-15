/** Failures that a macOS (BSD userland) host gives commands written for GNU tools, each with its working alternative. */
const HOST_QUIRKS: ReadonlyArray<{ failure: RegExp; command?: RegExp; hint: string }> = [
	{
		// bash: `/bin/bash: timeout: command not found`, `bash: line 1: timeout: ...`; zsh: `zsh:1: command not found: timeout`.
		failure: /^(?:[\w/.-]+:(?:\d+:)? (?:line \d+: )?)?(?:timeout: command not found|command not found: timeout)$/m,
		hint: "This host has no GNU `timeout` (macOS): drop it and set this tool's `timeout` parameter (seconds).",
	},
	{
		// BSD sed reads the word after `-i` as the backup suffix, so the script is taken for a file or a label.
		failure: /^sed: \d+: .*(?:undefined label|invalid command code)/m,
		// Any BSD sed script typo gives the same errors; the hint fits only a command that ran `sed -i`.
		command: /\bsed\s(?:[^|;&\n]*\s)?-i(?:\s|$)/,
		hint: "BSD sed (macOS) needs a suffix after -i: use `sed -i ''`, or edit with the `file` tool.",
	},
];

/** The hint for a failed command's output when it shows one of the known host quirks, else undefined; the quirks are macOS's, so other platforms get none. */
export function hostQuirkHint(
	output: string,
	command: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (platform !== "darwin") return undefined;
	return HOST_QUIRKS.find((quirk) => quirk.failure.test(output) && (quirk.command?.test(command) ?? true))?.hint;
}
