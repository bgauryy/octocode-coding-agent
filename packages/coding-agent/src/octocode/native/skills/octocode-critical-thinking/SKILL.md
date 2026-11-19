---
name: octocode-critical-thinking
description: "Use when critical thinking is required: a consequential, costly or hard-to-reverse decision, plan, design, diagnosis or claim resting on unchecked assumptions. Stress-tests with mental models (tail risks, inversion, second-order effects, Bayesian updating, Goodhart's law), scaled to the stakes."
---

# Octocode Critical Thinking

Spend effort in proportion to the stakes and avoid overthinking: a reversible one-line choice gets one question, an irreversible or costly one gets the full pass. The models:

- Black Swan/Tail Risks: Anticipate unknown unknowns and extreme failures.
- Antifragility/Optionality: Favor resilience, adaptability, and reversible decisions.
- Inversion/Pre-Mortem: Challenge assumptions and anticipate failure.
- Second-Order/Systems Thinking: Examine downstream effects, dependencies, and feedback loops.
- Bayesian Reasoning/Knightian Uncertainty: Update beliefs, calibrate confidence, and acknowledge uncertainty.
- First Principles/Occam's Razor: Question fundamentals and eliminate unnecessary complexity.
- Goodhart's Law/Opportunity Cost: Avoid metric traps and evaluate trade-offs.
- OODA Loop/Red Teaming: Adapt continuously and challenge conclusions adversarially.

## Pass

1. **State the claim and stakes.** One sentence: what is being decided, what it costs if wrong, and whether it can be undone.
2. **Pick the models that bite.** Do not run every model; choose those that can change this decision.

| Situation                                        | Models that usually decide                        |
| ------------------------------------------------ | ------------------------------------------------- |
| Irreversible, costly or public action            | Optionality, Tail Risks, Pre-Mortem               |
| A metric, test or benchmark is the goal          | Goodhart's Law, Red Teaming                       |
| Change touches shared code, data or other agents | Second-Order, Systems Thinking                    |
| Evidence is thin or conflicting                  | Bayesian Reasoning, Knightian Uncertainty         |
| Design feels heavy                               | First Principles, Occam's Razor, Opportunity Cost |
| Situation is moving (incident, live run)         | OODA Loop                                         |

3. **Attack the conclusion.** Answer the five questions with evidence, not opinion:
   - What's missing? Name the unchecked fact that could flip the decision.
   - What could go wrong? Assume it failed; list the most likely and the most severe cause.
   - What happens next? Trace one step past the immediate result: consumers, costs, feedback loops.
   - What would change my mind? Name the observation, then look for it when it is cheap.
   - Is there a better approach? Include doing less or nothing.
4. **Check before concluding.** Run the cheapest check that separates the conclusion from its strongest rival. Where no probability can be estimated, say so instead of inventing one.

## Output

Lead with the conclusion (the recommendation in one or two sentences), then as much as the stakes warrant: the key risks, worst first (trigger, impact, mitigation); the confidence (high, medium or low) and the evidence it rests on; and the observation that would reverse the conclusion.

Stop when another angle would not change the decision.
