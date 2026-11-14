/** Native capability filters cannot establish what a vendor CLI or external agent supports. */
export interface ExternalModelFilters {
	provider?: string;
	query?: string;
	ability?: string;
}

/** Match structured route identity, never headings, billing labels or arbitrary rendered rows. */
export function matchesExternalModel(
	filters: ExternalModelFilters | undefined,
	provider: string,
	text: string,
): boolean {
	return (
		!filters?.ability &&
		(!filters?.provider || provider.toLowerCase() === filters.provider.toLowerCase()) &&
		(!filters?.query || text.toLowerCase().includes(filters.query.toLowerCase()))
	);
}
