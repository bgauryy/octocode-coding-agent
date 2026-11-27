/** The settings a runner's availability for tasks lives in; `/providers` and the web page both write through this. */
export interface RunnerSettings {
	getExternalAgents(): boolean;
	setExternalAgents(enabled: boolean): void;
	getEnabledExternalAgents(): string[] | undefined;
	setEnabledExternalAgents(ids: readonly string[] | undefined): void;
}

/** Whether tasks may start runner `id`: the external-agents setting is on and the id is selected (no selection: none). */
export function isRunnerActive(settings: RunnerSettings, id: string): boolean {
	return settings.getExternalAgents() && (settings.getEnabledExternalAgents()?.includes(id) ?? false);
}

/** Opts one CLI in or out of the selection; enabling one also turns the external-agents setting on. */
export function setRunnerEnabled(settings: RunnerSettings, id: string, enabled: boolean): void {
	const others = (settings.getEnabledExternalAgents() ?? []).filter((runner) => runner !== id);
	settings.setEnabledExternalAgents(enabled ? [...others, id] : others);
	if (enabled) settings.setExternalAgents(true);
}
