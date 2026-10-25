import type { ApplicationEvent, ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import type { AgentSession } from "../../agent-session.ts";
import type { ApplicationStateStore } from "../state.ts";

export function applicationModel(session: Pick<AgentSession, "model">): ApplicationSnapshot["model"] {
	const model = session.model;
	return model ? { provider: model.provider, id: model.id, name: model.name, input: [...model.input] } : undefined;
}

export function publishModelChange(
	session: Pick<AgentSession, "model">,
	state: ApplicationStateStore,
	publish: (event: ApplicationEvent) => void,
): void {
	const model = applicationModel(session);
	if (JSON.stringify(model) !== JSON.stringify(state.getState().model)) publish({ type: "session.model", model });
}
