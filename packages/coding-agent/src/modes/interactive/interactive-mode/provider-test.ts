import type { ProviderTestResult } from "@octocodeai/octocode-contracts/config";
import { connectedProviders, testAll, testProvider } from "../../../octocode/subagents/provider-test.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

type TestView = Pick<ProviderManagerHost, "session" | "showStatus" | "showError" | "showWarning">;

const mark = (result: ProviderTestResult) => (result.status === "ok" ? "✓" : result.status === "failed" ? "✗" : "–");
const line = (result: ProviderTestResult) => `${mark(result)} ${result.name}: ${result.message}`;

/**
 * The provider page's `Test`: one small request for this provider (a model list can accept a key that inference
 * refuses), then the host's own model list against the configured ids, which names ids the host does not serve and the
 * nearest served ones. The shared `testProvider` runs it; the line carries redacted error text, never a key.
 */
export async function testProviderCredential(view: TestView, id: string, name: string): Promise<void> {
	const { session } = view;
	view.showStatus(`Testing ${name}…`);
	const result = await testProvider({ runtime: session.modelRuntime, model: session.model }, id, name);
	if (result.status === "skipped") view.showWarning(result.message);
	else if (result.status === "ok") view.showStatus(line(result));
	else view.showError(line(result));
}

/** `Test all`: every connected provider and the installed external agents, one result line each, only when chosen. */
export async function testAllProviders(view: TestView): Promise<void> {
	const { session } = view;
	const count = connectedProviders(session.modelRuntime).length;
	view.showStatus(`Testing ${count} provider${count === 1 ? "" : "s"} and the external agents…`);
	const results = await testAll({ runtime: session.modelRuntime, model: session.model });
	const text = results.map(line).join("\n");
	if (results.length === 0) view.showWarning("No connected provider or external agent to test.");
	else if (results.some((result) => result.status === "failed")) view.showError(text);
	else view.showStatus(text);
}
