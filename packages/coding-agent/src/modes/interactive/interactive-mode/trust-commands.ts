import { APP_NAME } from "../../../config.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../../core/trust-manager.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { TrustSelectorComponent } from "../components/trust-selector.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Project resource trust: `/trust project` and the decision saved after a reload into a trusted project. */
type TrustCommandsHost = Pick<
	InteractiveModeHost,
	| "autoTrustOnReloadCwd"
	| "runtimeHost"
	| "sessionManager"
	| "settingsManager"
	| "showSelector"
	| "showStatus"
	| "showWarning"
	| "ui"
>;

export function maybeSaveImplicitProjectTrustAfterReload(host: TrustCommandsHost): boolean {
	const cwd = host.sessionManager.getCwd();
	if (host.autoTrustOnReloadCwd !== cwd) {
		return false;
	}
	if (!host.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
		return false;
	}

	const trustStore = new ProjectTrustStore(host.runtimeHost.services.agentDir);
	try {
		if (trustStore.get(cwd) !== null) {
			host.autoTrustOnReloadCwd = undefined;
			return false;
		}
		trustStore.set(cwd, true);
		host.autoTrustOnReloadCwd = undefined;
		return true;
	} catch (error) {
		host.showWarning(`Could not save project trust after reload: ${errorMessage(error)}`);
		return false;
	}
}

export function showTrustSelector(host: TrustCommandsHost): void {
	const cwd = host.sessionManager.getCwd();
	const trustStore = new ProjectTrustStore(host.runtimeHost.services.agentDir);
	const savedDecision = trustStore.getEntry(cwd);
	host.showSelector((done) => {
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision,
			projectTrusted: host.settingsManager.isProjectTrusted(),
			onSelect: (selection) => {
				trustStore.setMany(selection.updates);
				done();
				host.showStatus(
					`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
				);
			},
			onCancel: () => {
				done();
				host.ui.requestRender();
			},
		});
		return { component: selector, focus: selector };
	});
}
