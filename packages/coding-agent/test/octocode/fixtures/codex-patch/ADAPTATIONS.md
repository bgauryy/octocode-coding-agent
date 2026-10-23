# Pinned patch oracle

The retained `oracle/` sources derive from OpenAI Codex revision `8eaf5fd115f036d207be236009938261758e30f2`, under Apache-2.0. Its LICENSE and NOTICE are retained. `manifest.json` records the original upstream file hashes; `oracle/sha256.json` records the adapted build inputs.

`parser.rs` removes unavailable PathUri imports and its `resolve_path` method. `streaming_parser.rs`, `seek_sequence.rs`, and `text_file.rs` retain upstream source bytes. `file_update.rs` retains the exact `compute_replacements` function; filesystem and diff wrappers are replaced with a pure transformation wrapper. `main.rs` is the local JSON-lines harness.

Run `python3 replay.py` from this directory (or pass its absolute path) to build the retained oracle in a temporary directory and verify all expected outputs. It requires Rust with the Cargo.lock dependencies already cached; the build is offline. `--write` regenerates expected outputs. Ordinary Vitest runs read only `corpus.json` and do not require Rust or network access.

This corpus verifies parsing and exact transformed text. It does not establish filesystem operations, path URI resolution, environment routing, permissions, whole-patch preparation, or move execution parity. Independent session tests cover the native execution owner.
