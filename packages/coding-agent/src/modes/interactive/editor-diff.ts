import { resolve } from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { splitConfigWords } from "../../configuration/command.ts";
import { assertEditorPath, runReferenceEditor, type ReferenceHost } from "./reference-opener.ts";
import {
	defaultOpenerHost,
	editorFamily,
	editorProgramName,
	launchDetached,
	resolveReferenceOpener,
	type EditorInvocation,
	type OpenerHost,
} from "./reference-launcher.ts";

/** Existing files are passed directly, so no temporary snapshot expires while a GUI is using it. */
export function editorDiffCommand(command: string, paths: string[], cwd: string): EditorInvocation | undefined {
	const [program, ...args] = splitConfigWords(command);
	if (!program || paths.length !== 2 || paths.some((path) => /[\x00-\x1f\x7f-\x9f]/u.test(path))) return undefined;
	const name = editorProgramName(program);
	if (editorFamily(program) === "vscode") args.push("--reuse-window", "--diff");
	else if (/^(?:vim|nvim|gvim)$/.test(name)) args.push("-d");
	else if (!/^(?:meld|bcompare)$/.test(name)) return undefined;
	args.push(...paths.map((path) => resolve(cwd, path)));
	return { command: program, args };
}

type DiffHost = ReferenceHost & { sessionManager: { getCwd(): string } };

/** A Code-family `referenceOpener` compares in the IDE window, detached; undefined sends the diff to the prompt editor. */
function openerDiffCommand(opener: EditorInvocation, paths: string[], cwd: string): EditorInvocation | undefined {
	if (editorFamily(opener.command) !== "vscode" || paths.length !== 2) return undefined;
	if (paths.some((path) => /[\x00-\x1f\x7f-\x9f]/u.test(path))) return undefined;
	const files = paths.map((path) => assertEditorPath(resolve(cwd, path)));
	return { command: opener.command, args: [...opener.args, "--reuse-window", "--diff", ...files] };
}

export async function openEditorDiff(
	host: DiffHost,
	args: string,
	openerHost: OpenerHost = defaultOpenerHost(),
): Promise<void> {
	const paths = splitConfigWords(args);
	if (paths.length !== 2) {
		host.showWarning('Usage: /diff --editor "before file" "after file"');
		return;
	}
	try {
		const opener = resolveReferenceOpener(
			host.settingsManager.getReferenceOpener(),
			host.settingsManager.getExternalEditorCommand(),
			openerHost,
		);
		const detached = opener.detached && openerDiffCommand(opener, paths, host.sessionManager.getCwd());
		if (detached) {
			await launchDetached(detached, { host: openerHost });
			host.showStatus(`Diff opened in ${editorProgramName(opener.command)}. The compared files remain on disk.`);
			return;
		}
	} catch (error) {
		host.showError(
			`Could not open editor diff: ${errorMessage(error)}. Use /diff [path] to review changes in the terminal.`,
		);
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
