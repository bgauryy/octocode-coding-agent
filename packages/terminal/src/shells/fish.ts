import type { ShellSpec } from "./spec.ts";

/**
 * fish prints completions for any string with `complete --do-complete`: value and description separated by a tab,
 * already escaped for the shell (flag `q`).
 */
const SCRIPT = `
printf '\\x1eREADY\\n'
while read -l req
    set -l parts (string split -m 1 \\t -- $req)
    for c in (complete --do-complete=$parts[2])
        set -l f (string split -m 1 \\t -- $c)
        printf '%s\\t%s\\t%s\\tq\\n' $parts[1] $f[1] (string replace -a \\t ' ' -- "$f[2]")
    end
    printf '%s\\t\\x1e\\n' $parts[1]
end
`;

export const fishSpec: ShellSpec = {
	name: "fish",
	binary: "fish",
	files: {},
	launch: ({ binary, loadRc, env }) => ({
		command: binary,
		args: [...(loadRc ? [] : ["--no-config"]), "--command", SCRIPT],
		env,
	}),
	segmentOnly: false,
};
