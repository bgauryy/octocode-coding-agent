# @octocodeai/octocode-common

Private workspace of host-free utilities shared by coding-agent, `packages/mcp` and `packages/acp`: JSON and text helpers, environment names, atomic and locked file writes, path and child-process helpers, terminal-text sanitizing and secret redaction (`sanitize.ts`), the SSRF-safe web guard (`web-guard.ts`), MCP and browser server names.

| Rule              | Detail                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Belongs here      | Needs only Node, its own dependencies and `contracts` (`common: ["contracts"]` in the package policy, enforced by `yarn run check:boundaries`)                                 |
| Stays in the host | Anything needing configuration, agent directories, themes, settings, trust or the model registry; reach shared packages through an injected port                               |
| Not published     | `octocodeSource` declares the `common` mount; the coding-agent build bundles it into its one bundle                                                                            |
| Importing         | Relative source paths (for example `../../../common/src/text.ts`) so the bundler follows them; `@octocodeai/octocode-common/<module>` resolves to source for tests and tooling |

Test: `yarn workspace @octocodeai/octocode-common run test`.
