# Changelog

## 0.1.0

First internal release.

- Model gateway (OpenAI chat, Anthropic messages, OpenAI Responses) with scripted replies or forwarding to a real model.
- Mock MCP servers, one trace for model and tool events, and Vitest matchers, each with a must-fail test.
- Adapters: reference loop, Claude Code, Codex, octocodecode; each behind its own subpath export.
- Run cache (cassettes): `auto`, `record`, `replay`; fingerprints, stale detection, per-trial `sample` keys and a cache report.
- Provider prompt cache markers on Anthropic forwarding, on by default.
- Model tiers (`local`, `haiku`, `deepseek`) and `live()` / `runTrials()` Bayesian statistical trials with `NoAnswer` errors kept apart from failures.
