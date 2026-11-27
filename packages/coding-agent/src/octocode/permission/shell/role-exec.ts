import { base, words } from "./words.ts";

/**
 * Programs a read-only role must not run in these forms, though the shell parse reads them as readers: they write a file
 * through an option (`base64 -o`, `ctags -f`), run another program (`man -P`, `tar --to-command`, `ssh -o ProxyCommand`)
 * or change remote state (`gh pr merge`, `gh api -X POST`). The scan is over every word of the command, so a false
 * match refuses a read, which this role can afford; a miss would let it write.
 */

const REMOTE_SHELLS = new Set(["ssh", "scp", "sftp", "rsync", "telnet", "nc", "ncat", "socat"]);
const GH_READS = new Set(["view", "list", "status", "diff", "checks", "search", "ls", "--help", "help", "version"]);
const GH_API_WRITES = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)(?:=|$)|^-[XfF]./;
const TAR_EXEC =
	/^(?:--to-command|--use-compress-program|--checkpoint-action|--info-script|--new-volume-script|--rsh-command|--rmt-command)(?:=|$)|^-[IF]/;

const option = (rest: string[], pattern: RegExp): boolean => rest.some((word) => pattern.test(word));

/** What `gh` changes with `rest`, or undefined for a listed read (`gh pr view`, GET `gh api`). */
function ghChange(rest: string[]): string | undefined {
	const plain = rest.filter((word) => !word.startsWith("-"));
	if (plain[0] === "api") {
		const method = rest.findIndex((word) => word === "-X" || word === "--method");
		const inline = rest.find((word) => /^(?:-X|--method=)/.test(word) && word.length > 2);
		const verb = (method >= 0 ? rest[method + 1] : inline?.replace(/^(?:-X|--method=)/, ""))?.toUpperCase();
		if (verb !== undefined && verb !== "GET") return `gh api -X ${verb}`;
		if (verb === undefined && option(rest, GH_API_WRITES)) return "gh api with fields (a POST)";
		return undefined;
	}
	if (plain[0] === "search") return undefined;
	const action = plain.length >= 2 ? plain[1] : plain[0];
	return action === undefined || GH_READS.has(action) ? undefined : `gh ${plain.slice(0, 2).join(" ")}`;
}

/** The first program form in `command` a read-only role refuses, described, or undefined. */
export function roleExecChange(command: string): string | undefined {
	const segments = command.split(/&&|\|\||[;|&\n()`]|\$\(/);
	for (const segment of segments) {
		let tokens: string[];
		try {
			tokens = words(segment);
		} catch {
			continue;
		}
		for (let at = 0; at < tokens.length; at++) {
			const name = base(tokens[at] ?? "");
			const rest = tokens.slice(at + 1);
			if (REMOTE_SHELLS.has(name)) return `${name} (it runs commands on another host or through its options)`;
			if (name === "gh") {
				const change = ghChange(rest);
				if (change) return `${change} (it changes GitHub or the checkout)`;
			}
			if (name === "man" && option(rest, /^(?:-P|--pager|-H|--html)(?:=|$)|^-[PH]./))
				return "man with a pager or browser program";
			if (name === "base64" && option(rest, /^(?:-o|--output)(?:=|$)|^-o./)) return "base64 -o (it writes a file)";
			if ((name === "ctags" || name === "etags") && option(rest, /^(?:-[fo]|--output)(?:=|$)|^-[fo]./))
				return `${name} -f (it writes a tags file)`;
			if ((name === "tar" || name === "bsdtar" || name === "gtar") && option(rest, TAR_EXEC))
				return `${name} running a program through its options`;
		}
	}
	return undefined;
}
