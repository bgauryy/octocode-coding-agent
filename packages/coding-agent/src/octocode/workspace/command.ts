import type { FeatureContext } from "../../core/features/index.ts";
import { say, type Subcommand, wordCompletions } from "../shared/commands.ts";
import { ITEM_REF } from "../shared/item-ref.ts";
import { plural } from "../shared/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** The usage line: `stop` only where a daemon can be stopped. */
const usage = (stop: boolean) => `Usage: /web [backlogs | item <id>${stop ? " | stop" : ""}]`;

/** `/web` arguments: the view to open and, for `item B12`, the item. Undefined when the arguments are not valid. */
export function parseWebArgs(args: string): { view: "board" | "activity"; item?: string } | undefined {
	const [word, id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	if (word === undefined) return { view: "activity" };
	if (word === "backlogs" && id === undefined) return { view: "board" };
	if (word !== "item" || extra.length || id === undefined) return undefined;
	const item = id.toUpperCase();
	return ITEM_REF.test(item) ? { view: "board", item } : undefined;
}

/**
 * What `/web` did with the daemon's page: opened it in a window or browser, or only gave its address; the daemon's pid,
 * and its idle limit in minutes (absent from an older daemon, which does not report it).
 */
export interface DaemonOpened {
	opened: boolean;
	pid: number;
	idleMinutes?: number;
}

/** The line after the daemon's page opened (or its address was given): how long it lives and where to see or stop it. */
function daemonText(result: DaemonOpened | undefined): string {
	const name = result ? `octocode-agent-web-${result.pid}` : "octocode-agent-web-<pid>";
	const lead = result && !result.opened ? "The web workspace is ready at the link above." : "Opened the web workspace.";
	const idle = result?.idleMinutes ? plural(result.idleMinutes, "minute") : "its idle time";
	return `${lead} It keeps running after this session closes and stops by itself after ${idle} with no browser tab and no attached session (/processes lists it as ${name}; /web stop ends it now).`;
}

/**
 * `/web`: the user-level daemon's page when `daemon` is given (every session), else this session's own server. When the
 * daemon cannot start or this session cannot attach, the session's own server opens instead, after a warning that says
 * why, so `/web` never fails silently. `/web stop` stops the daemon with `stop`.
 */
export function webCommand(
	/** This session's own server, the fallback: opens the page and resolves to its address. */
	open: (ctx: FeatureContext, view: "board" | "activity", item?: string) => Promise<string>,
	/** The user-level daemon: opens its page on this session; throws when it cannot. */
	daemon?: (ctx: FeatureContext, view: "board" | "activity", item?: string) => Promise<DaemonOpened | undefined>,
	/** Stops the user-level daemon: the pid it stopped, or undefined when none runs. */
	stop?: () => Promise<number | undefined>,
): Subcommand {
	return {
		description: "Open the web workspace",
		argumentHint: stop ? "[backlogs|item <id>|stop]" : "[backlogs|item <id>]",
		complete: (prefix) => wordCompletions(stop ? ["backlogs", "item", "stop"] : ["backlogs", "item"], prefix),
		async handler(args, ctx) {
			if (stop && args.trim() === "stop") {
				try {
					const pid = await stop();
					say(
						ctx,
						pid === undefined
							? "No web daemon is running."
							: `Stopped the web daemon (pid ${pid}): its pages and published links close within 30 seconds. Sessions keep running; /web starts it again.`,
					);
				} catch (error) {
					say(ctx, `Could not stop the web daemon: ${errorMessage(error)}`, "error");
				}
				return;
			}
			const parsed = parseWebArgs(args);
			if (!parsed) {
				say(ctx, usage(Boolean(stop)), "warning");
				return;
			}
			const { view, item } = parsed;
			const itemArg = item ? [item] : [];
			if (daemon) {
				try {
					say(ctx, daemonText(await daemon(ctx, view, ...itemArg)));
					return;
				} catch (error) {
					say(
						ctx,
						`The web daemon could not start (${errorMessage(error)}), so this session serves the page itself.`,
						"warning",
					);
				}
			}
			try {
				const url = await open(ctx, view, ...itemArg);
				say(
					ctx,
					`Opened the web workspace at ${url}\nKeep this session open for live updates; it stops when the session ends.`,
				);
			} catch (error) {
				say(ctx, "Could not open the web workspace: " + errorMessage(error), "error");
			}
		},
	};
}
