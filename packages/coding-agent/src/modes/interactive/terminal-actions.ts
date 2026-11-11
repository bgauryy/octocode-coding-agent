import { handleLinksCommand, handleSemanticCopy } from "./reference-actions.ts";
import { showTerminalDiagnostics } from "./terminal-diagnostics.ts";
import { openEditorDiff } from "./editor-diff.ts";

type TerminalActionHost = Parameters<typeof handleLinksCommand>[0] &
	Parameters<typeof showTerminalDiagnostics>[0] &
	Parameters<typeof openEditorDiff>[0];

/** Presentation actions share a small port; legacy commands keep their existing handlers. */
export async function runTerminalAction(host: TerminalActionHost, name: string, args: string): Promise<boolean> {
	if (name === "links") await handleLinksCommand(host, args.trim());
	else if (name === "copy" && args.trim()) await handleSemanticCopy(host, args.trim());
	else if (name === "debug" && args.trim()) {
		if (args.trim() === "terminal") showTerminalDiagnostics(host);
		else host.showWarning("Usage: /debug [terminal]");
	} else if (name === "diff" && /^--editor(?:\s|$)/.test(args)) {
		await openEditorDiff(host, args.replace(/^--editor\s*/, ""));
	} else return false;
	return true;
}
