---
name: architecture-best-option
description: Run improve-codebase-architecture, choose the best option, explain it simply, then grill an Opus stand-in for Greg on it.
disable-model-invocation: true
---

# Architecture best option

Run an architecture review and choose the best option yourself. Explain it to Greg in simple words. Then grill an Opus **stand-in** on it in place of Greg, in rounds, until you agree. The agreed answers are the accepted answers.

## Rules

- Load `improve-codebase-architecture` and follow it, with the changes in this skill. This skill wins where the two disagree.
- Give the best option in chat, in place of the HTML report. You choose the option, in place of Greg.
- In T3 Code, start the stand-in with `delegate_task`. Call `orchestrator_capabilities` once first and pick the latest Opus model. Use the target option `effort: "xhigh"`.
- Find facts yourself. A stand-in decides. It does not do your legwork.

## Steps

1. **Explore.** Do step 1 of `improve-codebase-architecture`. When Greg gives a direction, use it: $ARGUMENTS
2. **Choose the best option.** Rank the candidates and choose the best one.
3. **Explain it.** Give Greg only the best option. Explain it in simple words, as if Greg is five years old. Give the context around it, so that Greg can quickly understand what the proposal is. The context tells Greg:
   - What the code does now, and why that is a problem.
   - What the proposal changes.
   - Why this option is better than the other options.

   Then continue to step 4 in the same turn.
4. **Prepare round 1.** Load `grilling` and `domain-modeling`. Write round 1 in the `grilling` format. Cover the constraints, the dependencies, the shape of the deepened module, what sits behind the seam, and what tests survive. Give a recommendation for each question. Put the facts you found above the questions, with file and line references, so that the stand-in can check them.
5. **Start the stand-in.** Send the brief below, then the explanation from step 3 and round 1.
6. **Grill to agreement.** Read each reply. When a fact correction changes a decision, check it in the code. Accept good changes, push back on weak ones, and ask any new question that the reply opens. Send the next round to the same child thread with `t3_thread_send`, so that the stand-in keeps its context. **Agreement** means that each question has an answer that you and the stand-in both accept, and no new question is open. Stop rounds only at agreement.
7. **Keep the domain model current.** As decisions become clear, update `GLOSSARY.md` as step 3 of `improve-codebase-architecture` tells. When the stand-in rejects the whole option with a load-bearing reason, stop the rounds and record the reason for the report.
8. **Report.** Give Greg the accepted design in 3 to 5 sentences: the deepened module, its interface, what sits behind the seam, and what tests survive. List each decision where the stand-in changed your recommendation, and each glossary change. When the stand-in rejected the option, give its reason and offer an ADR. Then ask Greg whether to turn the design into issues.

## Stand-in brief

Send this text at the top of the stand-in task. Replace `<repo>`.

```
You stand in for Greg, the owner and sole developer of <repo>. A planning agent is grilling you on one architecture option: a refactor that makes a shallow module deep. Decide as Greg would: favor the simplest design that fully meets the need, deep modules, one canonical home for each rule, and the repo's documented principles.

Rules:
- Read only. Do not edit files, commit, or write to the issue tracker.
- Before you answer, read the repo's AGENTS.md, its design principles, its domain docs and glossaries, and the ADRs in the area. Inspect the code the questions name. Check the planner's facts against the code and say when one is wrong.
- For each numbered question, answer "Accept", "Reject" or "Change", with your reasons and your alternative when you do not accept. Push back when the recommendation is weak, too complex, or misses a case. Name any branch the planner missed as a new question with your own answer.
- Use glossary terms. Keep the reply compact: no preamble, no file dumps.
```
