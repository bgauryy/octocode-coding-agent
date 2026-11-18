/**
 * The declarations a deferrable native tool can take (`native-deferral.ts`), and what decides the on-demand one: a
 * transport that adds a declaration after the cached prefix.
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { supportsNativeToolLoading } from "@octocodeai/octocode-ai/utils/tool-loading";
import type { SetupPick, ToolDefinition } from "../../core/features/index.ts";

/** Both declarations of a deferrable tool, and which one is registered. */
export interface Forms {
	direct: ToolDefinition;
	deferred: ToolDefinition;
	/** Whether the session declared the tool thin when it started. */
	isDeferred: boolean;
	/** Whether the full form was declared since, in place, after a load. */
	redeclared: boolean;
	/** What the use record decided at registration: deferred (true) or direct. */
	byRecord: boolean;
	/** Registered on demand this session (inactive until loaded or called); set by `settleNativeDeferral`. */
	onDemand?: OnDemandApi;
}

export type OnDemandApi = SetupPick<"tools", "getActive" | "setActive">;

/** The full form registered on demand: `active` after a load in an earlier turn (resume), else inactive until used. */
export const onDemandForm = (forms: Forms, active: boolean): ToolDefinition => ({
	...forms.direct,
	onDemand: true,
	...(active ? {} : { defaultActive: false }),
});

/** An on-demand tool not yet declared: registered, inactive. */
export const undeclared = (name: string, forms: Forms): boolean =>
	forms.onDemand !== undefined && !forms.onDemand.tools.getActive().includes(name);

/** Whether the model's transport declares a tool after the cached prefix (tool loading mode other than `none`). */
export function addsInPlace(model: unknown): boolean {
	const valid = typeof model === "object" && model !== null && typeof (model as { api?: unknown }).api === "string";
	return valid && supportsNativeToolLoading(model as Model<Api>);
}
