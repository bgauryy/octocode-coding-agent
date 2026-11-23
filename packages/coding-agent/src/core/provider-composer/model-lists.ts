import type { Provider } from "@octocodeai/octocode-ai";

type RefreshContext = Parameters<NonNullable<Provider["refreshModels"]>>[0];

let published = 0;

/**
 * How many model lists providers have published in this process. A provider changes its list only through a refresh's
 * publication (`ModelsPublication.update`, the provider contract), so a list composed from providers stays valid while
 * this count is unchanged.
 */
export const publishedModelLists = (): number => published;

/** `context` whose publications that change a list are counted by `publishedModelLists`, right after their update. */
export function countingPublications(context: RefreshContext): RefreshContext {
	return {
		...context,
		publish: (publication) => {
			const { update } = publication;
			if (!update) return context.publish(publication);
			return context.publish({
				...publication,
				update: () => {
					try {
						update();
					} finally {
						published++;
					}
				},
			});
		},
	};
}
