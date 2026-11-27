# Design or debug an agent system

Moves in order; keep each step's check.

1. **Establish.** What the agent receives, the action it should take and an observable success check. New design: start with a direct call or one bounded loop. Failure: capture the actual harness version, instructions, schemas and trace, and reproduce it. Editorial work starts with the instruction and its consumer. Define success, partial and blocked outcomes within authorized budgets; verify changing provider behavior against current primary documentation.
2. **Trace** request → context → model → tools → verification → stop. Find the first wrong boundary, its mechanism, strongest rival and the check that tells them apart.
3. **Repair** the owning contract or policy: one owner per behavior, deterministic code over prose for repeatable logic, every call closing a named gap, unchanged verified results reused, large evidence kept by reference. Before adding complexity, ask what can be removed; drop arbitrary quotas, probes and metadata that help no action (an authorized cost, time or concurrency budget is a real constraint); keep real tool inputs, evidence and safety constraints. Retrieved content, tools, skills and peers never override operating rules.
4. **Verify** by replaying the deciding check and affected guardrails. Instructions state goals, constraints and decision rules; test behavior, not wording. Editorial and structural checks may finish with behavior unmeasured; reliability or cost claims need comparable tasks run before and after; label claims confirmed, inferred or unknown.
