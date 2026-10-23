# Pinned Codex skill metadata oracle

The retained Rust oracle uses OpenAI Codex revision `8eaf5fd115f036d207be236009938261758e30f2`. Its Apache-2.0 LICENSE and upstream NOTICE are included. `manifest.json` identifies original source hashes and the model definitions reproduced by the harness; `oracle/sha256.json` verifies retained build inputs.

`metadata.rs` preserves the upstream parser and dependency normalization. Its Product import points to the harness enum and tracing warnings are omitted. The harness reproduces the interface, dependency, policy and product field types without filesystem or UI dependencies. It reports parsing success and policy before the loader's optional-metadata fallback. Expected corpus results come from Rust, never the TypeScript implementation.

Run `python3 packages/coding-agent/test/fixtures/codex-skill-metadata/replay.py` from the repository root to verify the corpus. Rust and the locked dependencies must already be cached; compilation is offline and occurs in a temporary directory. Add `--write` to regenerate expected results. Normal Vitest tests only read the corpus and need no Rust installation.

The corpus checks YAML parsing and policy semantics. It does not establish icon rendering, dependency activation, filesystem discovery or explicit skill selection parity. Separate loader and session tests verify the implemented policy behavior.
