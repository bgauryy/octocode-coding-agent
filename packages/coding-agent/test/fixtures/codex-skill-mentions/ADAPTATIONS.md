# Pinned Codex mention oracle

`oracle/src/mentions.rs` preserves OpenAI Codex revision `8eaf5fd115f036d207be236009938261758e30f2` byte-for-byte. Its Apache-2.0 LICENSE and NOTICE are retained. `manifest.json` records source identity; `oracle/sha256.json` checks retained build inputs. The local harness extracts plain names and paths and sorts the sets for comparison.

Run `python3 packages/coding-agent/test/fixtures/codex-skill-mentions/replay.py` from the repository root. It builds offline in a temporary directory using Rust and already-cached locked dependencies, then verifies expected outputs. `--write` regenerates the corpus from Rust. Normal tests require neither Rust nor network access.

This oracle covers mention parsing, including whitespace and malformed-link fallback. Separate tests cover selection and session behavior. It does not establish structured input envelopes, remote catalog identities, connector discovery, or provider-specific message grouping.
