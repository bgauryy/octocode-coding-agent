import { afterEach, describe, expect, it, vi } from "vitest";
import { getApplicationPort, getApplicationPortForSession } from "../src/core/application/index.ts";
import { createTestSession, type TestSessionContext } from "./utilities.ts";

const contexts: TestSessionContext[] = [];
afterEach(() => {
	for (const context of contexts.splice(0)) context.cleanup();
});

async function newSession() {
	const context = await createTestSession({ inMemory: true });
	contexts.push(context);
	return context.session;
}

describe("AgentSession.dispose and the application port", () => {
	it("closes the session's open port", async () => {
		const session = await newSession();
		const port = getApplicationPort(session);
		session.dispose();
		expect(() => port.getSnapshot()).toThrow("Application service is closed");
		expect(getApplicationPortForSession(session.sessionId)).toBeUndefined();
	});

	it("opens no port when none is open: no subscription, nothing registered", async () => {
		const session = await newSession();
		getApplicationPort(session).dispose();
		const subscribe = vi.spyOn(session, "subscribe");
		session.dispose();
		// A repeated dispose finds the port already closed too.
		session.dispose();
		expect(subscribe).not.toHaveBeenCalled();
		expect(getApplicationPortForSession(session.sessionId)).toBeUndefined();
	});
});

describe("application operations", () => {
	it("runs a listed session operation", async () => {
		const session = await newSession();
		getApplicationPort(session).invoke("setSessionName", "renamed through the port");
		expect(session.sessionName).toBe("renamed through the port");
	});

	it("refuses session methods outside the operation list", async () => {
		const session = await newSession();
		const port = getApplicationPort(session);
		const dispose = vi.spyOn(session, "dispose");
		const bindExtensions = vi.spyOn(session, "bindExtensions");
		// An untyped caller (JavaScript, a cast) reaches `invoke` with any name.
		const invokeAny = port.invoke.bind(port) as (operation: string, ...args: unknown[]) => unknown;
		expect(() => invokeAny("dispose")).toThrow("dispose is not an application operation");
		expect(() => invokeAny("bindExtensions", {})).toThrow("bindExtensions is not an application operation");
		expect(() => invokeAny("sessionId")).toThrow("sessionId is not an application operation");
		expect(dispose).not.toHaveBeenCalled();
		expect(bindExtensions).not.toHaveBeenCalled();
	});
});
