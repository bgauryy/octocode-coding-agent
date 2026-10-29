import { expect, it } from "vitest";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contacts";
import { pageScope, scopedRoute } from "../src/scope.ts";

it("keeps host routes unchanged when the page has no daemon scope", () => {
	expect(pageScope("")).toBeUndefined();
	expect(scopedRoute(WORKSPACE_ROUTES.application, "")).toBe("/api/application");
	expect(scopedRoute(WORKSPACE_ROUTES.live, "?other=1")).toBe("/api/backlogs/live");
});

it("prefixes every route with the session or repository the page is bound to", () => {
	expect(pageScope("?s=abc-123")).toEqual({ kind: "session", id: "abc-123" });
	expect(scopedRoute(WORKSPACE_ROUTES.application, "?s=abc-123")).toBe("/s/abc-123/api/application");
	expect(scopedRoute(WORKSPACE_ROUTES.reports, "?r=0123abcd")).toBe("/r/0123abcd/api/reports");
	expect(scopedRoute(WORKSPACE_ROUTES.live, "?s=abc&r=zzz")).toBe("/s/abc/api/backlogs/live");
});

it("ignores a scope that is not a plain identifier, so a query cannot reach another path", () => {
	for (const search of ["?s=../etc", "?s=a/b", "?s=", "?r=%2e%2e%2f", `?s=${"x".repeat(200)}`, "?s=a%20b"]) {
		expect(pageScope(search), search).toBeUndefined();
		expect(scopedRoute("/api/backlogs", search)).toBe("/api/backlogs");
	}
});
