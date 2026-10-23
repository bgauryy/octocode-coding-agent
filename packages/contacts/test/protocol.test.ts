import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { BacklogMutationSchema, WorkspaceCommandSchema, WORKSPACE_ROUTES } from "../src/protocol.ts";

it("validates commands without admitting unknown actions or fields", () => {
  expect(Value.Check(WorkspaceCommandSchema, { id: "request-1", action: "message", to: "worker", text: "Review this" })).toBe(true);
  expect(Value.Check(WorkspaceCommandSchema, { id: "request-1", action: "exec", text: "run" })).toBe(false);
  expect(Value.Check(WorkspaceCommandSchema, { id: "request-1", action: "stop", permissions: "all" })).toBe(false);
});
it("shares entity schemas with transport and rejects invalid lifecycle values", () => {
  expect(Value.Check(BacklogMutationSchema, { op: "add", title: "Plan", type: "epic", state: "todo", dependsOn: ["B1"] })).toBe(true);
  expect(Value.Check(BacklogMutationSchema, { op: "update", state: "invented" })).toBe(false);
  expect(Value.Check(BacklogMutationSchema, { op: "update", priority: 9 })).toBe(false);
  expect(new Set(Object.values(WORKSPACE_ROUTES)).size).toBe(5);
});
