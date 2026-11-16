import { expect, it } from "vitest";
import { deriveAgentRoute, parseAgentRoute } from "../src/agent-route.ts";

it("derives the route from facts, runners and remote agents first", () => {
	expect(deriveAgentRoute({})).toBe("config");
	expect(deriveAgentRoute({ subscription: true })).toBe("subscription");
	expect(deriveAgentRoute({ subscription: true, remote: true })).toBe("remote");
	expect(deriveAgentRoute({ subscription: true, remote: true, runner: true })).toBe("external");
});

it("reads only named routes", () => {
	expect(parseAgentRoute("remote")).toBe("remote");
	expect(parseAgentRoute("x")).toBeUndefined();
	expect(parseAgentRoute(null)).toBeUndefined();
});
