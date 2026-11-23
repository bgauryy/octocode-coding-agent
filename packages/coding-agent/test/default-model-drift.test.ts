import { providers as snapshotProviders } from "@opencode-ai/models/snapshot";
import { getBuiltinModels, getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";
import { defaultModelPerProvider } from "../src/core/model-resolver/default-models.ts";

/**
 * The default-model drift check. It lives here, not in `ai/scripts/check-model-data.ts`: the defaults are coding-agent
 * policy and the ai package may not import coding-agent. The listings are the pinned `@opencode-ai/models` snapshot the
 * bundled catalog is generated from, so the answer changes only with a package bump.
 */

interface Listing {
	family?: string;
	status?: string;
	release_date?: string;
}

/** A default that is missing from the bundled catalog or deprecated fails; a newer release of its family is a note. */
function defaultModelDrift(
	defaults: Readonly<Record<string, string | undefined>>,
	bundledIds: (provider: string) => readonly string[],
	listings: (provider: string) => Readonly<Record<string, Listing>> | undefined,
): { problems: string[]; notes: string[] } {
	const problems: string[] = [];
	const notes: string[] = [];
	for (const [provider, id] of Object.entries(defaults)) {
		if (!id) continue;
		const ids = bundledIds(provider);
		if (!ids.includes(id)) {
			problems.push(`${provider}: default ${id} is not in the bundled catalog`);
			continue;
		}
		const listed = listings(provider);
		const own = listed?.[id];
		if (!listed || !own) continue;
		if (own.status === "deprecated") problems.push(`${provider}: default ${id} is deprecated on models.dev`);
		if (!own.family) continue;
		const region = id.includes(".") ? id.slice(0, id.indexOf(".") + 1) : "";
		const newer = ids
			.filter((other) => {
				const entry = listed[other];
				return (
					entry?.family === own.family &&
					entry.status !== "deprecated" &&
					(entry.release_date ?? "") > (own.release_date ?? "")
				);
			})
			.sort(
				(a, b) =>
					(listed[b]?.release_date ?? "").localeCompare(listed[a]?.release_date ?? "") ||
					Number(b.startsWith(region)) - Number(a.startsWith(region)) ||
					a.localeCompare(b),
			)[0];
		if (newer) notes.push(`${provider}: ${newer} is newer than the default ${id} (family ${own.family})`);
	}
	return { problems, notes };
}

describe("default model drift", () => {
	const bundled: Record<string, string[]> = { lab: ["model-2", "model-3", "other"], gone: ["model-1"] };
	const listings: Record<string, Record<string, Listing>> = {
		lab: {
			"model-2": { family: "model", release_date: "2026-01-01" },
			"model-3": { family: "model", release_date: "2026-06-01" },
			old: { family: "model", status: "deprecated" },
		},
	};
	const check = (defaults: Record<string, string>) =>
		defaultModelDrift(
			defaults,
			(provider) => bundled[provider] ?? [],
			(provider) => listings[provider],
		);

	it("fails a default missing from the bundled catalog or deprecated", () => {
		expect(check({ lab: "model-9" }).problems).toEqual(["lab: default model-9 is not in the bundled catalog"]);
		listings.lab["model-2"].status = "deprecated";
		try {
			expect(check({ lab: "model-2" }).problems).toEqual(["lab: default model-2 is deprecated on models.dev"]);
		} finally {
			delete listings.lab["model-2"].status;
		}
	});

	it("notes a newer model of the default's family without failing", () => {
		expect(check({ lab: "model-2" })).toEqual({
			problems: [],
			notes: ["lab: model-3 is newer than the default model-2 (family model)"],
		});
		expect(check({ lab: "model-3", gone: "model-1" })).toEqual({ problems: [], notes: [] });
	});

	it("holds for the shipped defaults against the pinned models.dev snapshot", () => {
		const { problems, notes } = defaultModelDrift(
			defaultModelPerProvider,
			(provider) =>
				getBuiltinProviders().includes(provider as never)
					? getBuiltinModels(provider as never).map((model) => model.id)
					: [],
			(provider) => snapshotProviders[provider]?.models,
		);
		if (notes.length > 0) console.info(`Newer default candidates:\n${notes.join("\n")}`);
		// Drift found when the check landed (2026-11-23, @opencode-ai/models 0.0.143). The defaults owner updates these
		// defaults; remove each line with its fix. Any other problem fails here.
		const knownDrift = [
			"cloudflare-workers-ai: default @cf/moonshotai/kimi-k2.6 is deprecated on models.dev",
			"minimax: default MiniMax-M2.7 is deprecated on models.dev",
			"minimax-cn: default MiniMax-M2.7 is deprecated on models.dev",
			"mistral: default devstral-medium-latest is deprecated on models.dev",
		];
		expect(problems.toSorted()).toEqual(knownDrift.toSorted());
	});
});
