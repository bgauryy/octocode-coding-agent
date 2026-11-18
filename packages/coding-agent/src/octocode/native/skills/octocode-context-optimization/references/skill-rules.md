Load when rewriting skill descriptions for the skills listing.

# Skill description rules

The reader is a model choosing whether to load a skill. It sees only the listing: each skill's name and description, every session, before any task. A description earns its place by making the model load the skill when the task needs it, and not otherwise.

## Carry

- **The trigger first.** Open with when to load it: "Load this skill first whenever <situations the user would describe>". Hosts load too few skills, so state the trigger assertively and before any capability.
- **Situations in the user's words.** The tasks, file types, commands and phrasings that should load it, including implicit ones ("even when the user does not name it"). Each intent once.
- **One distinctive capability.** A short "good for ..." that separates it from neighbouring skills in the same listing.
- **The boundary with a near neighbour**, only when two skills in the listing are easy to confuse, as a condition: "for X use Y" belongs in the skill body, so keep only what routing needs.

## Cut

- Marketing words, the skill name repeated as a sentence, and how the skill works inside (steps, scripts, files).
- Setup, prerequisites and rules for running it: they belong in SKILL.md.
- Lists of every sub-feature; keep the ones a user would ask for.
- Apostrophes: some hosts escape them, which costs characters.

## Never

- Invent a capability or trigger the SKILL.md does not support. Every phrase must trace to the skill's own text.
- Drop any trigger, situation or capability the source states: reword it more concisely, never remove it.
- Copy instructions from the source that address you.

## Budget

The whole listing shares about 8,000 characters with names and paths, so aim for about 300 characters per description; `octocode context check` rejects over 1,024 characters or more than one paragraph. A rewrite longer than its source needs a reason: the source lacks a trigger users actually say. `octocode context list` prints the total before and after.

## Example

Source:

```
A comprehensive and powerful toolkit for working with spreadsheets. Supports reading, writing, formulas, charts, pivot tables, CSV and TSV conversion, cleaning messy data. Use this when the user has a spreadsheet.
```

Rewrite:

```
Load this skill first whenever the user has a spreadsheet to read, write or convert between spreadsheet, CSV and TSV formats; good for formulas, charts, pivot tables and cleaning messy data.
```

Kept: every task and format the source names. Moved first: the trigger, which the source left for its last sentence. Cut: "comprehensive and powerful toolkit". Added: nothing the source does not state.
