# Changelog

## Unreleased

- `judge()` / `explainJudgement()`: grade a transcript against a rubric with a model you pass in; per-criterion verdicts and reasons.
- The Anthropic parser keeps `tool_addition` / `tool_removal` blocks and the block structure of system messages on `ChatMessage.blocks`; the request hash ignores them.

## 0.1.0

First internal release.

- Model gateway (OpenAI chat, Anthropic messages, OpenAI Responses) with scripted replies or forwarding to a real model.
- Mock MCP servers, one trace for model and tool events, and Vitest matchers, each with a must-fail test.
- Adapters: reference loop, Claude Code, Codex, octocodecode; each behind its own subpath export.
- Run cache (cassettes): `auto`, `record`, `replay`; fingerprints, stale detection, per-trial `sample` keys and a cache report.
- Provider prompt cache markers on Anthropic forwarding, on by default.
- Model tiers (`local`, `haiku`, `deepseek`) and `live()` / `runTrials()` Bayesian statistical trials with `NoAnswer` errors kept apart from failures.
