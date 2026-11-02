<!--
The `docs` section, dropped under a custom prompt and cleared for subagents. README.md and docs/ share the package
directory (`config.ts`), so the root is stated once. Value: root. The package has no examples/ folder and ships no SDK;
the trigger words are the topics docs/index.md maps.
-->
Octocode documentation, under {{root}} (not the working directory): README.md and docs/ (docs/index.md maps each topic to its page). Read it only when the user asks about Octocode itself (CLI, configuration, hooks, plugins, skills, MCP, themes, TUI), and follow the .md links a task depends on.
