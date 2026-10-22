# Security in octocode-code

octocode-code is an independent fork of [Pi](https://github.com/earendil-works/pi). It runs with the operating-system permissions of the user who launches it. Native permission checks, file guards, project trust and hook policies control supported agent actions; they are not an operating-system sandbox. Use process or container isolation when you need a stronger boundary.

Extensions and hooks execute local code. Install trusted packages and review project instructions, skills and configuration before granting trust. Retrieved text and model output can be adversarial; prompt instructions alone cannot enforce filesystem or network isolation.

## Native boundaries

- Permission modes and grants are enforced by `packages/coding-agent/src/octocode/permission/`. The current default mode is `full`; choose `OCTOCODE_PERMISSION=manual` or `workspace` when you want their additional checks.
- File reservations and guarded edits are coordinated by `team/` and `files/` under the same native directory.
- The local session API is opt-in. Its transport and authentication code lives in `api/`; keep discovery files and tokens private.
- A process with the same user's filesystem or debugger access can influence this agent. Child nonces and private file modes do not isolate it from that user account.
- External agents run with their own credentials, tools and permission policies.

See [configuration](packages/coding-agent/docs/configuration.md), [environment variables](packages/coding-agent/docs/environment-variables.md) and [native features](packages/coding-agent/docs/native-features.md).

## Reporting

Report fork-specific defects to this fork's maintainers. If GitHub private vulnerability reporting is enabled for the fork, use its Security tab. Otherwise ask the maintainers for a private reporting channel without posting exploit details or secrets publicly. This repository does not specify a dedicated security email or response-time commitment.

Include the affected commit or package version, configuration, reproduction steps, expected boundary and observed impact. Redact credentials and personal session contents. A bypass of an implemented permission, trust or API-authentication check is worth investigating even though the process is not sandboxed.

For defects confirmed in upstream Pi, follow the [upstream security policy](https://github.com/earendil-works/pi/security/policy). Upstream maintainers and infrastructure are not the reporting destination for fork-specific features.
