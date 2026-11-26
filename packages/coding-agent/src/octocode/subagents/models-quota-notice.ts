import type { QuotaReading } from "@octocodeai/octocode-ai";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { type ProviderQuotas, providerQuotas } from "../../core/model-runtime/quota-request.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { resetClock } from "@octocodeai/octocode-common/time";
import { QUOTA_HIGH } from "./models-quota.ts";
import { providerHealth } from "./provider-health.ts";
import { harnessSource, sourcedText } from "../events/source.ts";

/** The custom message type of the quota notice. */
export const QUOTA_NOTICE_ID = "octocode-quota-high";

/** A reset that moved less than this is the same window (`quota-request.ts` reads resets with rounding). */
const SAME_WINDOW_MS = 10 * 60_000;

type NoticeContext = Pick<FeatureContext, "model" | "modelRegistry">;

/**
 * Tells the agent once per plan window when its session's provider passed {@link QUOTA_HIGH} of it: the window, its reset,
 * and the connected providers that are not limited. A window is its provider, its id and its reset: the next period of
 * the same window (a later reset) is told again. Kept in memory per session; `reset` forgets it on a session switch.
 */
export class QuotaWatch {
	/** `provider\0window` → the reset of the window last told about (undefined: it named none). */
	readonly #told = new Map<string, number | undefined>();
	readonly #quotas: Pick<ProviderQuotas, "current" | "now">;
	readonly #limited: (provider: string) => boolean;

	constructor(
		quotas: Pick<ProviderQuotas, "current" | "now"> = providerQuotas,
		refused: (provider: string) => boolean = (provider) => providerHealth.refused(provider),
	) {
		this.#quotas = quotas;
		this.#limited = (provider) => refused(provider) || this.#high(provider).length > 0;
	}

	reset(): void {
		this.#told.clear();
	}

	/** The plan windows of `provider` in force at or past the mark. */
	#high(provider: string): QuotaReading[] {
		return this.#quotas
			.current(provider)
			.filter((reading) => reading.kind === "plan" && reading.usedFraction >= QUOTA_HIGH);
	}

	/** Whether `reading` is a window not told about yet: new, or a later period of one told before. */
	#untold(reading: QuotaReading): boolean {
		const key = `${reading.provider}\0${reading.window}`;
		if (!this.#told.has(key)) return true;
		const told = this.#told.get(key);
		if (told === undefined || reading.resetsAt === undefined) return false;
		return Math.abs(reading.resetsAt - told) > SAME_WINDOW_MS;
	}

	/** The notice for the session provider's fullest window not told about yet, once; undefined when there is none. */
	notice(ctx: NoticeContext): string | undefined {
		const provider = ctx.model?.provider;
		if (!provider) return undefined;
		const reading = this.#high(provider)
			.filter((candidate) => this.#untold(candidate))
			.sort((a, b) => b.usedFraction - a.usedFraction)[0];
		if (!reading) return undefined;
		this.#told.set(`${reading.provider}\0${reading.window}`, reading.resetsAt);
		const others = [...new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider))]
			.filter((other) => other !== provider && !this.#limited(other))
			.sort();
		return renderPrompt("notices/models/quota-high.md", {
			provider,
			used: `${Math.round(reading.usedFraction * 100)}%`,
			window: reading.label,
			resets: reading.resetsAt === undefined ? "" : resetClock(reading.resetsAt, this.#quotas.now()),
			others: others.join(", "),
		});
	}
}

/**
 * Sends the quota notice as a hidden message: with the run's first request (`before_agent_start`), and after a turn that
 * pushed the window past the mark mid-run (`turn_end`, read by the run's next request). Each provider response updates
 * the readings, so these are the points where a new reading can be told.
 */
export function registerQuotaNotice(api: FeatureSetup, watch: QuotaWatch = new QuotaWatch()): QuotaWatch {
	api.bus.on("session_start", () => watch.reset());
	api.bus.on("before_agent_start", (_event, ctx) => {
		const notice = watch.notice(ctx);
		return notice
			? {
					message: {
						customType: QUOTA_NOTICE_ID,
						content: sourcedText(notice, harnessSource("models")),
						display: false,
					},
				}
			: undefined;
	});
	api.bus.on("turn_end", async (_event, ctx) => {
		const notice = watch.notice(ctx);
		// It starts no turn, so it settles at once; a failure reaches the bus's error report.
		if (notice)
			await api.session.sendMessage(
				{ customType: QUOTA_NOTICE_ID, content: sourcedText(notice, harnessSource("models")), display: false },
				{ triggerTurn: false },
			);
	});
	return watch;
}
