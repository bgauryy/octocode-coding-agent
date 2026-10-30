/**
 * `/github`: GitHub sign-in for Octocode research, through the native CLI's `octocode auth` device flow.
 */

import {
	describeGithubStatus,
	type GithubAuthOptions,
	runGithubAuth,
} from "../../../../../mcp/src/presets/octocode/github-auth.ts";
import { errorMessage } from "../../../utils/guards.ts";
import { LoginDialogComponent } from "../components/login-dialog.ts";
import type { InteractiveModeHost } from "./host.ts";
import { refreshGithubFooter, updateGithubFooter } from "./github-footer.ts";
import { showInEditorSlot } from "./login-dialogs.ts";

const GITHUB_ACTIONS = ["status", "login", "logout"] as const;

/** Interactive-mode members used by `/github`. */
type GithubCommandHost = Pick<
	InteractiveModeHost,
	| "footerDataProvider"
	| "editor"
	| "editorContainer"
	| "programStatus"
	| "showError"
	| "showExtensionConfirm"
	| "showStatus"
	| "showWarning"
	| "ui"
>;

type RunGithubAuth = typeof runGithubAuth;

/**
 * `status` shows the active account, `login` runs the device flow, `logout` removes the stored login. Without an
 * action, shows the status and signs in when there is no token; a rejected environment token is only reported, since a
 * login cannot take its place.
 */
export async function handleGithubCommand(
	host: GithubCommandHost,
	args: string,
	run: RunGithubAuth = runGithubAuth,
): Promise<void> {
	const action = args.trim();
	if (action !== "" && !(GITHUB_ACTIONS as readonly string[]).includes(action)) {
		host.showWarning("Usage: /github [status|login|logout]");
		return;
	}
	try {
		if (action === "logout") {
			// As /logout does: removing a stored sign-in asks first.
			if (!(await host.showExtensionConfirm("Sign out of GitHub", "Remove Octocode's stored GitHub sign-in?"))) {
				host.showStatus("Still signed in to GitHub.");
				return;
			}
			const result = await run("logout");
			await refreshGithubFooter(host, run);
			host.showStatus(`Signed out of GitHub on ${result.hostname}. Environment and gh CLI credentials are unchanged.`);
			return;
		}
		if (action !== "login") {
			const status = await run("status");
			updateGithubFooter(host, status);
			if (action === "status" || status.authenticated || status.tokenSource.startsWith("env:")) {
				host.showStatus(describeGithubStatus(status));
				return;
			}
		}
		await login(host, run);
	} catch (error) {
		updateGithubFooter(host);
		host.showError(`GitHub: ${errorMessage(error)}`);
	}
}

async function login(host: GithubCommandHost, run: RunGithubAuth): Promise<void> {
	const dialog = new LoginDialogComponent(host.ui, "github", () => {}, "GitHub");
	showInEditorSlot(host, dialog);
	dialog.showProgress("Requesting a device code...");
	const options: GithubAuthOptions = {
		signal: dialog.signal,
		onDeviceCode: (code) => {
			dialog.showDeviceCode(code);
			dialog.showWaiting("Waiting for authentication...");
		},
	};
	host.programStatus.setBlocked("login", { kind: "auth", message: "Log in to GitHub" });
	try {
		const result = await run("login", options);
		showInEditorSlot(host, host.editor);
		const account = `${result.username || "your account"} on ${result.hostname}`;
		host.showStatus(
			result.action === "none"
				? `Already signed in to GitHub as ${account}. Run /github logout to switch accounts.`
				: `Signed in to GitHub as ${account}`,
		);
		// An environment token takes priority over the stored login until it is unset.
		const status = await run("status");
		updateGithubFooter(host, status);
		if (status.tokenSource.startsWith("env:")) {
			host.showWarning(
				`${status.tokenSource.slice("env:".length)} is set and takes priority over this login until you unset it.`,
			);
		}
	} catch (error) {
		showInEditorSlot(host, host.editor);
		if (errorMessage(error) !== "Login cancelled") throw error;
		host.showStatus("GitHub login cancelled");
	} finally {
		host.programStatus.setBlocked("login", undefined);
	}
}
