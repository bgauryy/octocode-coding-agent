# Extension fixtures

These examples exercise the extension API in regression tests. Octocode's built-in features do not require installing them. Load one for a try-out with `octocode --extension ./examples/extensions/<name>`, or read it as the implementation reference for the behavior in the second column.

| Example                                                        | Shows                                                                                                                            | Tests                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`built-in-tool-renderer.ts`](built-in-tool-renderer.ts)       | Re-registering `bash` with compact `renderCall`/`renderResult` while delegating execution                                        | `test/tool-renderer-examples.test.ts`                        |
| [`minimal-mode.ts`](minimal-mode.ts)                           | A collapsed tool display mode that hides output until expanded                                                                   | `test/tool-renderer-examples.test.ts`                        |
| [`input-transform-streaming.ts`](input-transform-streaming.ts) | `input` handlers that skip expensive work when `streamingBehavior` marks mid-stream steering                                     | `test/input-transform-streaming-example.test.ts`             |
| [`trigger-compact.ts`](trigger-compact.ts)                     | Requesting compaction with `ctx.compact()` when context use crosses a threshold                                                  | `test/trigger-compact-extension.test.ts`                     |
| [`git-merge-and-resolve.ts`](git-merge-and-resolve.ts)         | Fetch and merge after each turn, then feed conflicts back to the agent                                                           | `test/git-merge-and-resolve-extension.test.ts`               |
| [`jev-router.ts`](jev-router.ts)                               | A virtual model that plans on a strong model and implements on a cheaper one; see [virtual models](../../docs/virtual-models.md) | `test/jev-router-example.test.ts`                            |
| [`plan-mode/`](plan-mode/README.md)                            | Plan extraction, tool selection and progress widgets                                                                             | `test/plan-mode-extension.test.ts`                           |
| [`subagent/`](subagent/README.md)                              | Subprocess delegation. Native sessions already provide the `agent` tool, so this is a fixture only                               | `test/suite/regressions/8261-subagent-project-trust.test.ts` |
| [`with-deps/`](with-deps/)                                     | An extension directory with its own `package.json` and npm dependencies                                                          | `test/extensions-discovery.test.ts`                          |

See the [extension API reference](../../docs/extensions.md).
