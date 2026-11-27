/**
 * `/providers` → add an external agent → **Your own CLI or ACP agent**: writes an `externalModels` entry to the global
 * settings.json, which `/model` lists after a reload. The form asks for the few fields every entry needs; the variable
 * names it may be passed (`env`) and a display name stay in the file.
 */

import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ExternalModelEntry } from "../../../core/settings-schema/external-models.ts";
import { RESERVED_IDS } from "../../../octocode/cli-models/sources.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

/** The choice that opens the form, in the external agents list. */
export const OWN_AGENT_LABEL = "Your own CLI or ACP agent — added to externalModels in settings.json";

type FormHost = Pick<
	ProviderManagerHost,
	"session" | "showInputDialog" | "showSelectorDialog" | "showStatus" | "showError"
>;

const REPLACE = "Replace the existing entry";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const KINDS = {
	"ACP agent — an Agent Client Protocol agent over stdio, given Octocode's tools": "acp",
	"CLI — one process per request, the conversation on stdin, no Octocode tools": "cli",
} as const;

/** Why `id` cannot name a new entry, else undefined. */
export function idRefusal(id: string): string | undefined {
	if (!ID_PATTERN.test(id))
		return "Use lowercase letters, digits, dot, dash and underscore, starting with a letter or digit.";
	if (RESERVED_IDS.has(id)) return `${id} is a built-in CLI's id.`;
	return undefined;
}

const words = (text: string, separator: RegExp): string[] =>
	text
		.split(separator)
		.map((word) => word.trim())
		.filter(Boolean);

/** The entry a form's answers describe: arguments split on spaces, model ids on commas. */
export function externalModelEntry(answers: {
	id: string;
	kind: "acp" | "cli";
	command: string;
	args: string;
	models: string;
}): ExternalModelEntry {
	const args = words(answers.args, /\s+/);
	const models = words(answers.models, /,/);
	return {
		id: answers.id.trim(),
		kind: answers.kind,
		command: answers.command.trim(),
		...(args.length ? { args } : {}),
		...(models.length ? { models } : {}),
	};
}

/** Asks for each field in turn; Escape or an empty required answer ends the form. Returns true when an entry was written. */
export async function addExternalModel(host: FormHost): Promise<boolean> {
	const ask = async (title: string, hint: string) => (await host.showInputDialog(title, hint))?.trim();
	let id: string | undefined;
	for (;;) {
		id = await ask("Provider id (models appear as <id>/<model>)", "my-agent");
		if (!id) return false;
		const refusal = idRefusal(id);
		if (!refusal) break;
		host.showError(refusal);
	}
	if (host.session.settingsManager.getExternalModels().some((entry) => entry.id === id)) {
		const replace = await host.showSelectorDialog(`externalModels already has ${id}. Replace it?`, [REPLACE, "Cancel"]);
		if (replace !== REPLACE) return false;
	}
	const picked = await host.showSelectorDialog("What kind of agent is it?", Object.keys(KINDS));
	const kind = picked ? KINDS[picked as keyof typeof KINDS] : undefined;
	if (!kind) return false;
	const command = await ask(
		"Command: a name on PATH, or a path",
		kind === "acp" ? "my-agent" : "/usr/local/bin/my-cli",
	);
	if (!command) return false;
	const args = await host.showInputDialog(
		kind === "cli" ? "Arguments, space-separated ({model} is the chosen model)" : "Arguments, space-separated",
		kind === "acp" ? "acp" : "--model {model}",
	);
	if (args === undefined) return false;
	const models = await host.showInputDialog(
		"Model ids, comma-separated (empty: default, or what the agent advertises)",
		"fast, smart",
	);
	if (models === undefined) return false;
	try {
		host.session.settingsManager.addExternalModel(externalModelEntry({ id, kind, command, args, models }));
	} catch (error) {
		host.showError(`Could not save ${id}: ${errorMessage(error)}`);
		return false;
	}
	host.showStatus(`Added ${id} to externalModels in settings.json. Run /reload to use it from /model.`);
	return true;
}
