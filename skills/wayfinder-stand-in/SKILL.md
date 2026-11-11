---
name: wayfinder-stand-in
description: Work every frontier ticket of a Wayfinder map, with an Opus stand-in in place of Greg on each grilling ticket.
disable-model-invocation: true
---

# Wayfinder stand-in

Greg gives a Wayfinder map. You work its whole frontier in this session. On each grilling ticket, an Opus **stand-in** answers for Greg. You grill the stand-in in rounds until you agree. The agreed answers are the accepted answers.

## Rules

- Load `wayfinder` and follow "Work through the map", with the changes in this skill. This skill wins where the two disagree.
- Work all frontier tickets in one session. This replaces the Wayfinder limit of one ticket per session.
- In T3 Code, start each stand-in with `delegate_task`. Call `orchestrator_capabilities` once first and pick the latest Opus model.
- Find facts yourself, or with a fact finder. A stand-in decides. It does not do your legwork.
- Skip the ELI5 overview. The final report replaces it.

## Steps

1. **Load the frontier.** Read the map body and query its child tickets with their blockers. The frontier is the open, unblocked, unclaimed tickets.
2. **Sort and claim.** Read each frontier ticket's `wayfinder:<type>` label.
   - Grilling: claim it, then work it with a stand-in, as steps 3 to 6 tell.
   - Research: claim it, then resolve it as `wayfinder` tells.
   - Prototype, or a task that needs Greg: leave it unclaimed for Greg, and list it in the report.

   Claim all grilling and research tickets before you start work on any of them.
3. **Prepare round 1.** For each grilling ticket, load `grilling` and `domain-modeling`. Read the ticket, the resolution comments of closed tickets on the map, and the code the question reaches. Write round 1 in the `grilling` format. Give a recommendation for each question. Put the facts you found above the questions, with file and line references, so the stand-in can check them.
4. **Start the stand-ins.** Start one stand-in for each grilling ticket. Use the target option `effort: "xhigh"`. Start stand-ins for independent tickets in parallel. Send the brief below, then the ticket context and round 1.
5. **Grill to agreement.** Read each reply. When a fact correction changes a decision, check it in the code. Accept good changes, push back on weak ones, and ask any new question that the reply opens. Send the next round to the same child thread with `t3_thread_send`, so the stand-in keeps its context. **Agreement** means that each question has an answer that you and the stand-in both accept, and no new question is open. Stop rounds only at agreement.
6. **Reconcile across tickets.** Two stand-ins can decide the same value in different ways, for example a retry backoff. When they do, the decision on the ticket that closed first wins, and the later resolution refers to it. When a stand-in amends a closed decision, put a short pointer comment on that closed ticket. When a stand-in finds an item that belongs to another open ticket, post that item on the other ticket as a comment.
7. **Record each resolution.** Post the resolution comment, then close the ticket. In each comment, say that a stand-in for Greg reviewed the decision, as Greg asked. Write all tracker text in Simplified Technical English with glossary terms.
8. **Update the map one time.** After all tickets close, read the map body again, because other sessions can change it. Add one Decisions so far line for each closed ticket. Add Out of scope lines, update the fog, and add new tickets as `wayfinder` tells.
9. **Recompute the frontier.** When closures unblock new grilling or research tickets, go back to step 1 for them. Stop when the frontier has no grilling or research ticket.
10. **Report.** Give Greg 2 or 3 sentences for each grilling ticket. Each summary states the accepted and resolved approach. Link each ticket by its name. Then list the tickets that are next on the frontier and those that are blocked, and say which ones need Greg.

## Stand-in brief

Send this text at the top of each stand-in task. Replace `<repo>` and `<map>`.

```
You stand in for Greg, the owner and sole developer of <repo>. A planning agent is grilling you on one Wayfinder decision ticket. Decide as Greg would: favor the simplest design that fully meets the need, deep modules, one canonical home for each rule, and the repo's documented principles.

Rules:
- Read only. Do not edit files, commit, or write to the issue tracker.
- Before you answer, read the repo's AGENTS.md, its design principles, its domain docs and glossaries, the map issue <map>, the ticket, and the resolution comments of the closed map tickets. Inspect the code the questions name. Check the planner's facts against the code and say when one is wrong.
- For each numbered question, answer "Accept", "Reject" or "Change", with your reasons and your alternative when you do not accept. Push back when the recommendation is weak, too complex, or misses a case. Name any branch the planner missed as a new question with your own answer.
- Use glossary terms. Keep the reply compact: no preamble, no file dumps.
```
