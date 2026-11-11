import { basename, resolve } from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { splitConfigWords } from "../../configuration/command.ts";
import { runReferenceEditor, type ReferenceHost } from "./reference-opener.ts";

/** Existing files are passed directly, so no temporary snapshot expires while a GUI is using it. */
export function editorDiffCommand(
	command: string,
	paths: string[],
	cwd: string,
): { command: string; args: string[] } | undefined {
	const [program, ...args] = splitConfigWords(command);
	if (!program || paths.length !== 2 || paths.some((path) => /[\x00-\x1f\x7f-\x9f]/u.test(path))) return undefined;
	const name = basename(program.replaceAll("\\", "/"))
		.replace(/\.(?:exe|cmd|bat)$/i, "")
		.toLowerCase();
	if (/^(?:code|code-insiders|codium|cursor)$/.test(name)) args.push("--reuse-window", "--diff");
	else if (/^(?:vim|nvim|gvim)$/.test(name)) args.push("-d");
	else if (!/^(?:meld|bcompare)$/.test(name)) return undefined;
	args.push(...paths.map((path) => resolve(cwd, path)));
	return { command: program, args };
}

type DiffHost = ReferenceHost & { sessionManager: { getCwd(): string } };

export async function openEditorDiff(host: DiffHost, args: string): Promise<void> {
	const paths = splitConfigWords(args);
	if (paths.length !== 2) {
		host.showWarning('Usage: /diff --editor "before file" "after file"');
		return;
	}
	const invocation = editorDiffCommand(
		host.settingsManager.getExternalEditorCommand(),
		paths,
		host.sessionManager.getCwd(),
	);
	if (!invocation) {
		host.showWarning(
			"The configured editor has no supported diff interface. Use /diff [path] for a terminal diff, or configure Code, Codium, Cursor, Vim, Neovim, Meld or Beyond Compare.",
		);
		return;
	}
	try {
		await runReferenceEditor(host, invocation);
		host.showStatus("Diff editor returned. The compared files remain on disk.");
	} catch (error) {
		host.showError(
			`Could not open editor diff: ${errorMessage(error)}. Use /diff [path] to review changes in the terminal.`,
		);
	}
}
