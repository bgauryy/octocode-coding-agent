import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { APP_NAME, getAgentDir } from "../config.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { providerSourceGate } from "../core/provider-sources/gate.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { cliStyle } from "../utils/cli-style.ts";
import { providerSource, providerSourceLabel, type ProviderSource } from "./provider-source.ts";

/** One provider definition: the one in use, or one that another file's definition of the same id replaced. */
export interface ProviderRow {
	id: string;
	source: ProviderSource | "built-in";
	/** The file whose definition replaced this one; undefined for the definition in use. */
	shadowedBy?: string;
}

type RowRuntime = Pick<ModelRuntime, "getProviders" | "getProviderDefinitionFile" | "getModelsDiagnostics">;

/** Every provider with where it is defined, then each replaced definition with the file that replaced it. */
export function providerRows(runtime: RowRuntime): ProviderRow[] {
	const rows: ProviderRow[] = runtime
		.getProviders()
		.map((provider) => {
			const source = providerSource(runtime, provider.id);
			return { id: provider.id, source: source.file ? source : ("built-in" as const) };
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	for (const shadowed of runtime.getModelsDiagnostics().getShadowedDefinitions()) {
		const { scope, product } = runtime.getModelsDiagnostics().describeFile(shadowed.file);
		rows.push({
			id: shadowed.provider,
			source: { file: shadowed.file, scope, product },
			shadowedBy: shadowed.shadowedBy,
		});
	}
	return rows;
}

function formatRows(rows: readonly ProviderRow[]): string {
	const cells = rows.map((row) => [
		row.id,
		row.source === "built-in" ? "built-in" : providerSourceLabel(row.source),
		row.shadowedBy ? `shadowed by ${homeTilde(row.shadowedBy)}` : "",
	]);
	const width = (column: number) => Math.max(...cells.map((cell) => cell[column].length));
	return cells
		.map((cell) => `${cell[0].padEnd(width(0))}  ${cell[1].padEnd(width(1))}  ${cell[2]}`.trimEnd())
		.join("\n");
}

const USAGE = `Usage: ${APP_NAME} providers list [--json]\nLists every provider with the models.json it is defined in (scope and product) and the files whose definition of the same id it replaced.`;

/** `octocode providers list [--json]`: read-only, makes no provider request. Resolves to the exit status. */
export async function runProvidersCommand(args: string[], context: { cwd: string }): Promise<number> {
	const rest = args.slice(1);
	if (
		args[0] === undefined ||
		args[0] === "help" ||
		rest.includes("--help") ||
		rest.includes("-h") ||
		args[0] === "--help"
	) {
		console.log(USAGE);
		return 0;
	}
	const unknown = rest.find((arg) => arg !== "--json");
	if (args[0] !== "list" || unknown) {
		console.error(
			cliStyle.error(`Error: ${unknown ? `Unknown option ${unknown}.` : `Unknown providers command "${args[0]}".`}`),
		);
		console.error(cliStyle.dim(USAGE));
		return 1;
	}
	const settings = SettingsManager.create(context.cwd, getAgentDir());
	providerSourceGate.set(settings.getProviderSources());
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: false,
		project: { cwd: context.cwd, isTrusted: () => settings.isProjectTrusted() },
	});
	try {
		const rows = providerRows(runtime);
		console.log(rest.includes("--json") ? JSON.stringify({ providers: rows }) : formatRows(rows));
		const problem = runtime.getError();
		if (problem) console.error(cliStyle.warn(`Warning: errors loading models.json:\n${problem}`));
		for (const warning of runtime.getConfigWarnings()) console.error(cliStyle.dim(warning));
		return 0;
	} finally {
		runtime.dispose();
	}
}
