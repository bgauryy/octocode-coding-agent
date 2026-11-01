import { ApplicationService } from "./service.ts";
import type { ApplicationSession } from "./session-port.ts";

const services = new WeakMap<ApplicationSession, ApplicationService>();
const registered = new Set<ApplicationService>();

export function getApplicationPort(session: ApplicationSession): ApplicationService {
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

/** Close the session's port if one is open; never opens one (opening subscribes and projects the transcript). */
export function disposeApplicationPort(session: ApplicationSession): void {
	services.get(session)?.dispose();
}

export function getApplicationPortForSession(sessionId: string): ApplicationService | undefined {
	const matches = [...registered].filter((service) => service.sessionId === sessionId);
	if (matches.length > 1) throw new Error("Multiple active application sessions share this session ID");
	return matches[0];
}
