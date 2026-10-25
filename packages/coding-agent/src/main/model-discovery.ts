import { discoverProviderModels } from "@octocodeai/octocode-ai/providers/discovery";
import { APP_NAME } from "../config.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { isTruthyEnvFlag } from "./startup.ts";

/** Explicit, read-only vendor discovery; never makes an inference request. */
export async function runModelDiscoveryCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "models") return false;
	if (args.includes("--help") || args.includes("-h") || args[1] === "help" || args[1] === undefined) {
		console.log(
			`Usage: ${APP_NAME} models discover [--provider <id>] [--offline] [--json]\nLists vendor model IDs and compares them with the configured catalog. Unknown IDs need model metadata before use. --offline uses only the local catalog.`,
		);
		return true;
	}
	try {
		if (args[1] !== "discover") throw new Error("Expected models discover");
		let providerId: string | undefined;
		let offline = isTruthyEnvFlag(process.env.OCTOCODE_OFFLINE);
		let json = false;
		for (let index = 2; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--provider") {
				const value = args[++index];
				if (!value || value.startsWith("--")) throw new Error("--provider requires an ID");
				providerId = value;
			} else if (arg === "--offline") offline = true;
			else if (arg === "--json") json = true;
			else throw new Error(`Unknown model discovery argument: ${arg}`);
		}
		const signal = AbortSignal.timeout(60_000);
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
		const ids = providerId ? [providerId] : runtime.getProviders().map((provider) => provider.id);
		// Bound concurrency; vendor failures remain separate results.
		const results = [];
		for (let offset = 0; offset < ids.length; offset += 4) {
			results.push(
				...(await Promise.all(
					ids
						.slice(offset, offset + 4)
						.map((id) => discoverProviderModels(runtime, id, { allowNetwork: !offline, signal })),
				)),
			);
		}
		if (json) console.log(JSON.stringify(results, null, 2));
		else
			for (const result of results) {
				console.log(`${result.provider}: ${result.status} (${result.models.length} models)`);
				if (result.note) console.log(`  ${result.note}`);
				if (result.docs) console.log(`  Documentation: ${result.docs}`);
				for (const model of result.models) console.log(`  ${model.id}${model.known ? "" : " — metadata required"}`);
				if (result.missingFromVendor?.length)
					console.log(`  Not listed by vendor: ${result.missingFromVendor.join(", ")}`);
			}
		if (results.some((result) => result.status === "error" || result.status === "unconfigured")) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Model discovery failed");
		process.exitCode = 1;
	}
	return true;
}
