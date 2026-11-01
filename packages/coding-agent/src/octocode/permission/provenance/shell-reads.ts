import { bashSyntax } from "../bash-syntax.ts";
import { shellPath, shellTargetAccess, shellTargetPath } from "../file-access.ts";

/** Words that name a place, not a read: discarding output reads nothing. */
const NOT_READ = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);
/** A word that spells a path a command may read: absolute, from the home directory, or above the current directory. */
const PATH_WORD = /^(?:\/|~(?:\/|$)|\.\.(?:\/|$)|[A-Za-z]:[\\/])/;

const unquote = (word: string): string => word.replace(/^(['"])(.*)\1$/s, "$2");

/**
 * The first file outside the workspace a shell command reads, as the shell spells it resolved against `cwd`; undefined
 * when it names none. Bash: the read targets the permission gate classifies (`shellTargetAccess`, `read.outside`: the
 * operands of `cat`, `head`, `tail`, `wc`, an input redirect), then any literal word that spells an outside path, which
 * covers other readers (`rg`, `sed -n`, `jq`, `git -C`) and a `cd` into an outside directory (`cd /etc && cat x`).
 * PowerShell, or a line the parse cannot read, falls back to the whitespace-separated words. Over-tagging only costs an
 * ask on egress, so a mention of an outside path counts as a read of it.
 */
export function outsideShellRead(
	command: string,
	cwd: string,
	inWorkspace: (file: string) => boolean,
	shell: "bash" | "powershell",
): string | undefined {
	const outside = (word: string | undefined): string | undefined => {
		if (word === undefined || NOT_READ.has(word) || !PATH_WORD.test(word)) return undefined;
		const file = shellPath(cwd, word);
		return inWorkspace(file) ? undefined : file;
	};
	const syntax = shell === "bash" ? bashSyntax(command) : undefined;
	if (syntax && !syntax.incomplete) {
		for (const target of syntax.targets) {
			if (target.kind !== "read" || target.policyOnly) continue;
			if (shellTargetAccess(target, cwd).action !== "read.outside") continue;
			const spelled = shellTargetPath(target);
			const file = spelled === undefined ? undefined : shellPath(cwd, spelled);
			if (file !== undefined && !inWorkspace(file)) return file;
		}
		for (const part of syntax.commands)
			for (const token of part.tokens) {
				const found = outside(token.literal);
				if (found !== undefined) return found;
			}
		return undefined;
	}
	for (const word of command.split(/[\s;|&()<>]+/)) {
		const found = outside(unquote(word));
		if (found !== undefined) return found;
	}
	return undefined;
}
