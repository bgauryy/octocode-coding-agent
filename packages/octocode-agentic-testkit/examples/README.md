# Adapter examples

Tested adapters for agents that run in the test process. Each one points the framework's model client at the gateway
(`${ctx.gatewayUrl}/v1`, dummy key), turns every mock MCP tool into a framework tool named `mcp__<server>__<tool>`, keeps
the conversation across `run()` calls, and returns the final answer and the messages. `close()` aborts a run still in
flight.

Each example needs its framework installed next to the kit; the kit itself does not depend on any of them.

| File                                    | Framework                 | Shows                                                                                                           |
| --------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [ai-sdk.ts](adapters/ai-sdk.ts)         | Vercel AI SDK 7 (`ai`)    | `generateText` tool loop on the OpenAI chat or Anthropic Messages wire; a sub-agent tool                        |
| [langchain.ts](adapters/langchain.ts)   | LangChain 1 (`langchain`) | `createAgent` with `ChatOpenAI` and JSON Schema tools                                                           |
| [agent-loop.ts](adapters/agent-loop.ts) | none: your own loop       | a loop over a pluggable `ModelClient` (plain `fetch`), the pattern for any in-process library; a sub-agent tool |

[`test/examples.test.ts`](../test/examples.test.ts) runs each adapter through `agentSuite` against a scripted gateway
and a mock MCP server, offline: a turn that calls the tool, a turn answered from the conversation, a failing tool the
model recovers from, and for the sub-agent examples a delegation the gateway infers without headers.

| Example         | Install                                                   |
| --------------- | --------------------------------------------------------- |
| `ai-sdk.ts`     | `ai@7`, `@ai-sdk/openai@4`, `@ai-sdk/anthropic@4`         |
| `langchain.ts`  | `langchain@1`, `@langchain/core@1`, `@langchain/openai@1` |
| `agent-loop.ts` | nothing beyond the kit                                    |

## Use one

1. Copy the file into your project. It imports the kit by its package name, as your tests do.
2. Replace the framework call (`generateText`, `createAgent`, `runLoop`) with your agent. Keep the model, tool and
   history wiring.
3. Script it with `startGateway({ responder: scripts({ main: [...] }) })`, or run it against a real model with
   `startGateway({ forward })`: the adapter does not change.

## Sub-agents without headers

The AI SDK and agent-loop examples take `subagents: { <role>: <system prompt> }` and add a `delegate({ agent, task })`
tool that runs a second model call with that prompt and the task as its first user message. No request carries an
`x-testkit-agent` header. The gateway recognizes the child because its first user message holds the task string (12 or
more characters) of the parent's pending tool call. It takes the child's role from the call's `agent` argument
(`subagent_type`, `role` and `type` also work). So `scripts({ main: [...], researcher: [...] })` routes the child's
requests, and `toHaveSpawned("researcher")` and `toHaveHandedOff("main", "researcher")` hold.

A sub-agent's MCP calls are attributed to it on the mock's side too: the mock credits each call to the agent whose
model asked for that tool most recently.
