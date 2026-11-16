/** Notices per silent episode: at the threshold, then twice and four times it; a longer silence gets no more. */
const NOTICES_PER_EPISODE = 3;
/** A child found legitimately idle (its turn ended, it waits on a timer or job) is not read again for this long. */
const RECHECK_MS = 60_000;

interface Episode {
	/** The child's last progress this episode is about; new progress starts a new episode. */
	lastOutputAt: number;
	told: number;
	skipUntil: number;
}

/**
 * Which running children of this agent have made no progress (`lastOutputAt`: their last model or tool event) for the
 * threshold. It only compares timestamps the parent already holds, so the team ticker can ask every second; the caller
 * reads the database only for the ids it returns, and reports back with `told` or `excused`.
 */
export class SilenceWatch {
	private readonly episodes = new Map<string, Episode>();

	/** Ids due a notice now; `children` are the running children with their last progress (undefined: none yet). */
	due(
		children: ReadonlyArray<{ id: string; lastOutputAt: number | undefined }>,
		thresholdMs: number,
		now: number,
	): string[] {
		const live = new Set(children.map((child) => child.id));
		for (const id of this.episodes.keys()) if (!live.has(id)) this.episodes.delete(id);
		if (thresholdMs <= 0) return [];
		return children.flatMap(({ id, lastOutputAt }) => {
			if (lastOutputAt === undefined) return [];
			let episode = this.episodes.get(id);
			if (episode?.lastOutputAt !== lastOutputAt) {
				episode = { lastOutputAt, told: 0, skipUntil: 0 };
				this.episodes.set(id, episode);
			}
			if (episode.told >= NOTICES_PER_EPISODE || now < episode.skipUntil) return [];
			return now - lastOutputAt >= thresholdMs * 2 ** episode.told ? [id] : [];
		});
	}

	/** The parent was told about `id`'s current silence. */
	told(id: string): void {
		const episode = this.episodes.get(id);
		if (episode) episode.told += 1;
	}

	/** `id` waits legitimately (idle between turns, or on the user): look again a minute later. */
	excused(id: string, now: number): void {
		const episode = this.episodes.get(id);
		if (episode) episode.skipUntil = now + RECHECK_MS;
	}

	reset(): void {
		this.episodes.clear();
	}
}
