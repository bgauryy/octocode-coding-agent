# @octocodeai/octocode-common (private workspace)

This private workspace holds host-free utilities that the coding-agent host, `packages/mcp` and `packages/acp` share: JSON and text helpers, environment names, atomic and locked file writes, path and child-process helpers, the SSRF-safe web guard, and the MCP and browser server names. It imports nothing from `packages/coding-agent/src`, `packages/mcp` or `packages/acp`; `scripts/check-package-boundaries.mjs` enforces that through its package policy (`common: []`).

Like the MCP and ACP workspaces it is not published. `octocodeSource` mounts it at coding-agent's `src/common/`, `scripts/build-host-sources.mjs` compiles it into coding-agent's `dist/common/`, and the host ships its runtime dependencies. Import it with relative source paths (`../../common/src/<module>.ts` from a sibling workspace, `../common/<module>.ts` from the host's `src/`) so the host compiler can relocate them. Workspace exports (`@octocodeai/octocode-common/<module>`) resolve to source for tests and tooling.

A module belongs here when it needs only Node, its own dependencies and other published packages. Anything that needs host configuration (`config.ts`, agent directories, themes, settings, trust or the model registry) stays in the host and reaches a shared package through an injected port.
