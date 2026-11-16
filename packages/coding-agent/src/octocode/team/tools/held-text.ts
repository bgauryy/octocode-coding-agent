import { CONFINE_FLAGS } from "../interpreter-confinement.ts";

/** Why the reservation gate refused a command it cannot check, and what to do instead. */
export const POWERSHELL_HELD =
	"This PowerShell command was not run: the paths it writes cannot be checked against reservations, so while another agent holds one only read-only commands run. Use the file tool for edits.";
export const INTERPRETER_HELD = ({ name, cause }: { name: string; cause: string }): string =>
	`This command runs ${name} on inline code that names a path another agent has reserved, and its writes cannot be checked (${cause}). Inline code that names no reserved path runs. Instead: write the code to a script file under .octocode/code/temp/ and run that file, or use the file tool for edits. ${
		name === "node" || name === "nodejs"
			? `To read with Node, put \`${CONFINE_FLAGS}\` before \`-e\`: Node then refuses writes and child processes.`
			: "To read, use the read tools."
	}`;
/** A refused run that is no interpreter: a reader given a computed word, a wrapper hiding its command, arithmetic on an unknown value. */
export const NOT_CHECKED_HELD = ({ name, cause }: { name: string; cause: string }): string =>
	`This command was not run: what it writes cannot be checked against reservations, so while another agent holds one it is refused${/^[\w.+-]+$/.test(name) ? ` (\`${name}\`)` : ""}. Why: ${cause}. Instead: write the command to a script file under .octocode/code/temp/ and run that file, or use the file tool for edits.`;

/** A package-manager script run (`yarn run x`, `npm test`, `pnpm run x`): what it writes is not in the command line. */
export const PACKAGE_SCRIPT =
	/(?:^|[;&|(]\s*)(?:(?:npm|pnpm|bun)\s+(?:run(?:-script)?|test|start)\b|yarn\s+(?:workspaces?\s+\S+\s+)?(?:run|test|start)\b)/;
export const PACKAGE_SCRIPT_REPEAT =
	"[A reservation is held: this script may have changed a reserved file. Check `coordinate` `changes`.]";
export const PACKAGE_SCRIPT_NOTE =
	"[Another agent holds a reservation and this command ran a package script: reservations cannot check what a script writes, so it may have changed a reserved file. Check `coordinate` `changes` before relying on those files.]";
