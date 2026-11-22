import { RUNNERS } from "./runners.ts";

/** The settings a runner's availability for tasks lives in; `/providers` and the web page both write through this. */
export interface RunnerSettings {
	getExternalAgents(): boolean;
	setExternalAgents(enabled: boolean): void;
	getEnabledExternalAgents(): string[] | undefined;
	setEnabledExternalAgents(ids: readonly string[] | undefined): void;
}

/** Whether tasks may start runner `id`: the external-agents setting is on and the id is selected (or nothing is selected yet). */
export function isRunnerActive(settings: RunnerSettings, id: string): boolean {
	const selected = settings.getEnabledExternalAgents();
	return settings.getExternalAgents() && (selected === undefined || selected.includes(id));
}

/** A fresh selection opts in one CLI; an explicit legacy all-runners setting keeps the other known CLIs. */
export function setRunnerEnabled(settings: RunnerSettings, id: string, enabled: boolean): void {
	const selected =
		settings.getEnabledExternalAgents() ?? (settings.getExternalAgents() ? RUNNERS.map((runner) => runner.id) : []);
	const others = selected.filter((runner) => runner !== id);
	settings.setEnabledExternalAgents(enabled ? [...others, id] : others);
	if (enabled) settings.setExternalAgents(true);
}
