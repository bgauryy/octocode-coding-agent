import type { ApplicationEvent, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import type { ApplicationSession } from "../session-port.ts";
import type { ApplicationStateStore } from "../state.ts";

export function applicationModel(session: Pick<ApplicationSession, "model">): ApplicationSnapshot["model"] {
	const model = session.model;
	return model ? { provider: model.provider, id: model.id, name: model.name, input: [...model.input] } : undefined;
}

export function publishModelChange(
	session: Pick<ApplicationSession, "model">,
	state: ApplicationStateStore,
	publish: (event: ApplicationEvent) => void,
): void {
	const model = applicationModel(session);
	if (JSON.stringify(model) !== JSON.stringify(state.getState().model)) publish({ type: "session.model", model });
}
