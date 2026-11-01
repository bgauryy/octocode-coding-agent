<!--
The `docs` section, dropped under a custom prompt and cleared for subagents. README.md, docs/ and examples/ share the
package directory (`config.ts`), so the root is stated once. Value: root.
-->
Octocode documentation, under {{root}} (not the working directory); read only when the user asks about Octocode itself, its SDK, extensions, themes, skills, or TUI:
- README.md; docs/ (docs/index.md maps every Octocode topic to its page); examples/ (extensions, custom tools, SDK)
- Read the docs and examples that define the behavior, follow .md cross-references a task depends on, and read a whole section when its conditions or exceptions matter.
