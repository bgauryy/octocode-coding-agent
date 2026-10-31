import { randomUUID } from "node:crypto";
import type { ApplicationActivity, ApplicationHistory } from "@octocodeai/octocode-contracts";
import type { AgentSessionEvent } from "../../agent-session.ts";
import type { SessionEntry } from "../../session-manager.ts";
import type { ApplicationAssets } from "../assets.ts";
import { cloneDisplay } from "../normalize.ts";
import type { ApplicationStateStore } from "../state.ts";
import { ApplicationCollection } from "../collection.ts";
import { APPLICATION_EVENT_ROUTES, entryActivity, nativeActivity, type ActivityData } from "./activity-data.ts";

type ActivityPage = Pick<ApplicationHistory, "activities" | "activityBefore" | "hasMoreActivities">;
/** Current-branch metadata and current-process notifications, retained independently of bounded views. */
export class ApplicationActivities {
	private readonly entries: ApplicationCollection<ApplicationActivity>;
	private get values(): ReadonlyMap<string, ApplicationActivity> {
		return this.entries.values;
	}
	private shellId = randomUUID();
	private readonly assets: ApplicationAssets;
	constructor(assets: ApplicationAssets, state: ApplicationStateStore) {
		this.assets = assets;
		this.entries = new ApplicationCollection(
			() => state.getState().activities,
			(activities) => state.setState({ activities }),
		);
	}
	batch(work: () => void): void {
		this.entries.batch(work);
	}
	private put(
		input: ActivityData,
		identity: Pick<ApplicationActivity, "id" | "at" | "source" | "entryId">,
		slot?: string,
	): ApplicationActivity {
		const activity: ApplicationActivity = {
			...identity,
			kind: input.kind,
			text: input.text.slice(0, 4000),
			...(input.failed ? { outcome: "failed" as const } : {}),
		};
		if (input.text.length > 4000 && input.data === undefined)
			activity.full = this.assets.put(input.text, "text/plain", "utf8", undefined, slot);
		if (input.data !== undefined) {
			const data = cloneDisplay(input.data);
			const json = JSON.stringify(data);
			if (json.length > 4000) activity.full = this.assets.put(json, "application/json", "utf8", undefined, slot);
			else activity.data = data;
		}
		this.entries.set(activity.id, activity);
		return cloneDisplay(activity);
	}
	entry(entry: SessionEntry): ApplicationActivity | undefined {
		const data = entryActivity(entry);
		if (!data) return undefined;
		return this.put(data, {
			id: `entry:${entry.id}`,
			entryId: entry.id,
			at: Date.parse(entry.timestamp) || 0,
			source: "session",
		});
	}
	project(event: AgentSessionEvent): ApplicationActivity | undefined {
		if (event.type === "message_end" && event.message.role === "bashExecution") {
			this.shellId = randomUUID();
		}
		if (!APPLICATION_EVENT_ROUTES[event.type].includes("activity")) return undefined;
		if (event.type === "entry_appended") return this.entry(event.entry);
		if (event.type === "bash_execution_update") {
			const id = `bash:${event.id ?? this.shellId}`;
			const previous = this.values.get(id);
			const text =
				(previous?.full ? (this.assets.get(previous.full.id)?.data ?? "") : (previous?.text ?? "")) + event.delta;
			const activity = this.put(
				{ kind: event.type, text },
				{ id, at: this.values.get(id)?.at ?? Date.now(), source: "live" },
				id,
			);
			return activity;
		}
		const data = nativeActivity(event);
		return data ? this.put(data, { id: `activity:${randomUUID()}`, at: Date.now(), source: "live" }) : undefined;
	}
	private page(activities: ApplicationActivity[], end: number): ActivityPage {
		return cloneDisplay({ activities, activityBefore: activities[0]?.id, hasMoreActivities: end > activities.length });
	}
	window(): ActivityPage {
		const activities = [...this.values.values()].slice(-50);
		while (activities.length > 1 && JSON.stringify(activities).length > 32768) activities.shift();
		return this.page(activities, this.values.size);
	}
	history(options: { activityBefore?: string; limit?: number }): ActivityPage {
		const all = [...this.values.values()];
		const end =
			options.activityBefore === undefined ? all.length : all.findIndex((item) => item.id === options.activityBefore);
		if (end < 0) throw new Error("Activity cursor is not in this session");
		return this.page(all.slice(Math.max(0, end - Math.max(1, Math.min(100, options.limit ?? 50))), end), end);
	}
	clear(): void {
		this.entries.clear();
	}
}
