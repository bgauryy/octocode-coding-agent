import type { AgentSession } from "../agent-session.ts";
import { ApplicationService } from "./service.ts";

const services = new WeakMap<AgentSession, ApplicationService>();
const registered = new Set<ApplicationService>();

export function getApplicationPort(session: AgentSession): ApplicationService {
	let service = services.get(session);
	if (!service) {
		service = new ApplicationService(session, (disposed) => {
			registered.delete(disposed);
			services.delete(session);
		});
		services.set(session, service);
		registered.add(service);
		if (typeof session.subscribe === "function") service.start();
	}
	return service;
}

export function getApplicationPortForSession(sessionId: string): ApplicationService | undefined {
	const matches = [...registered].filter((service) => service.sessionId === sessionId);
	if (matches.length > 1) throw new Error("Multiple active application sessions share this session ID");
	return matches[0];
}
