import type { FolderTrustAsker } from "../../../core/folder-trust.ts";
import { FolderNotTrustedError } from "../../../core/folder-trust.ts";
import { folderTrustPrompt, type TrustChoice, type TrustPromptInput } from "../components/folder-trust-prompt.ts";
import type { InteractiveModeHost } from "./host.ts";

/**
 * Moving a running session into another folder (resume, new session with a cwd, worktree switch, import) asks about trust
 * first, in the session, and only then replaces it. A "no" keeps the current session open with a warning; it is not a crash.
 */

/** Shows the folder trust question in place of the editor; resolves with the answer (Esc is "not now"). */
function promptFolderTrustInSession(
	host: Pick<InteractiveModeHost, "showSelector">,
	input: TrustPromptInput,
): Promise<TrustChoice> {
	return new Promise<TrustChoice>((resolve) => {
		host.showSelector((done) => {
			const prompt = folderTrustPrompt(input, (choice) => {
				resolve(choice);
				done();
			});
			// Replaced by another selector before an answer: nothing was decided.
			return { component: prompt, focus: prompt, dispose: () => resolve("not-now") };
		});
	});
}

/** Installs the gate's asker on the runtime, with the in-session prompt as its way to ask. */
export function installFolderTrustAsker(
	host: Pick<InteractiveModeHost, "runtimeHost" | "showSelector">,
	create: ((prompt: (input: TrustPromptInput) => Promise<TrustChoice>) => FolderTrustAsker) | undefined,
): void {
	if (create) host.runtimeHost.folderAdmission.ask = create((input) => promptFolderTrustInSession(host, input));
}

/** Reports a switch the trust check refused and returns true; any other error is left to the caller. */
export function warnRefusedSwitch(
	host: Pick<InteractiveModeHost, "showWarning">,
	error: unknown,
): error is FolderNotTrustedError {
	if (!(error instanceof FolderNotTrustedError)) return false;
	host.showWarning(error.message);
	return true;
}
