import { ModelRegistry } from "../../../core/model-registry.ts";
import {
	checkCandidates,
	checkProviders,
	describeHealth,
	providerHealth,
} from "../../../octocode/subagents/provider-health.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

/**
 * The provider page's `Test credential`: the one-request check `/modelsettings check` runs, for this provider only. The
 * result line comes from the same health record, whose error text is already redacted; no key is shown.
 */
export async function testProviderCredential(
	host: Pick<ProviderManagerHost, "session" | "showStatus" | "showError" | "showWarning">,
	id: string,
	name: string,
): Promise<void> {
	const registry = new ModelRegistry(host.session.modelRuntime);
	const available = registry.getAvailable().filter((candidate) => candidate.provider === id);
	if (available.length === 0) {
		host.showWarning(`${name} has no available model to test with.`);
		return;
	}
	host.showStatus(`Testing ${name}…`);
	await checkProviders(registry, checkCandidates(available, host.session.model), providerHealth);
	const status = providerHealth.get(id);
	if (!status) host.showWarning(`${name}: the check gave no result.`);
	else if (status.ok) host.showStatus(`${name}:${describeHealth(status)}`);
	else host.showError(`${name}:${describeHealth(status)}`);
}
