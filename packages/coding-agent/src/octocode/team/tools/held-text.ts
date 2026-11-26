import { CONFINE_FLAGS } from "../interpreter-confinement.ts";

/** Why the reservation gate refused a command it cannot check, and what to do instead. */
export const POWERSHELL_HELD =
	"This PowerShell command was not run: the paths it writes cannot be checked against reservations, so while another agent holds one only read-only commands run. Use the file tool for edits.";
export const INTERPRETER_HELD = ({ name, cause }: { name: string; cause: string }): string =>
	`This command runs ${name} on inline code that names a path another agent has reserved, and its writes cannot be checked (${cause}). Inline code that names no reserved path runs. Instead: write the code to a script file under .octocode/agent/temp/ and run that file, or use the file tool for edits. ${
		name === "node" || name === "nodejs"
			? `To read with Node, put \`${CONFINE_FLAGS}\` before \`-e\`: Node then refuses writes and child processes.`
			: "To read, use the read tools."
	}`;
/** A refused run that is no interpreter: a reader given a computed word, a wrapper hiding its command, arithmetic on an unknown value. */
export const NOT_CHECKED_HELD = ({ name, cause }: { name: string; cause: string }): string =>
	`This command was not run: what it writes cannot be checked against reservations, so while another agent holds one it is refused${/^[\w.+-]+$/.test(name) ? ` (\`${name}\`)` : ""}. Why: ${cause}. Instead: write the command to a script file under .octocode/agent/temp/ and run that file, or use the file tool for edits.`;

/**
 * A run whose writes are not in the command line: a package script (`yarn <script>`, `yarn workspace <ws> run <script>`,
 * `npm run`, `pnpm`, `bun`), `make`, a shell script file (`bash x.sh`) or a program path (`./x`). Yarn, pnpm and bun
 * subcommands that only report (`--version`, `help`, `info`, `why`, `list`, `bin`) are not. Each may follow a wrapper
 * (`VAR=x`, `env`, `time`, `nohup`, `sudo`, `command`, `exec`, with their options: `sudo -u x`) or open a quoted
 * `bash -c` string; `npx` counts too. Not opaque: `npx` of an interpreter the inline-code parse reads (`tsx`, `ts-node`,
 * `node`), and formatter runs, which the repository-wide format gate owns (`yarn oxfmt <files>` names its writes).
 */
export const OPAQUE_RUNNER =
	/(?:^|[;&|("']\s*)(?:(?:[A-Za-z_]\w*=\S*|(?:env|time|nohup|sudo|command|exec)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*)\s+)*(?:npx\s+(?!(?:tsx|ts-node|node|oxfmt|prettier)\b)\S|npm\s+(?:run(?:-script)?|test|start|exec)\b|(?:yarn|pnpm|bun)(?:\s+(?!(?:-v|--version|help|info|why|list|bin|oxfmt|prettier)\b)[\w@./:-]+|(?=\s*(?:$|[;&|)])))|make\b|(?:bash|sh|zsh)(?:\s+-(?!c\b)\S+)*\s+[^\s-]\S*|\.{1,2}\/\S+)/;
/** The question asked before an opaque runner starts while another agent holds a reservation (`held` names the holder and path). */
export const OPAQUE_RUNNER_ASK = (held: string): string =>
	`This command runs a script or program whose writes cannot be checked against reservations, and another agent holds one: it may change a reserved file. ${held}`;

/** A formatter run over the whole repository while reservations are held: it rewrites files outside them. */
export const REPO_WIDE_FORMAT_HELD =
	"This command was not run: it formats the whole repository while reservations are held, which rewrites files other agents or sessions are changing. Instead: format only the files you changed with `yarn oxfmt <files>`; `yarn oxfmt --check` and `yarn run format:check` still run.";
