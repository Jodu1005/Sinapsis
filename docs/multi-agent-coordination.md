# Multi-agent coordination: experiment record and operating rules

Updated: 2026-08-11

This document records live, mock-human channel experiments. It is deliberately
outcome-oriented: a conversation is good when it reaches a better, auditable
decision—not when it produces the most messages or Handoffs.

## Operating model

| Situation | Route | Expected result |
| --- | --- | --- |
| Independent first-pass work | Several `@handles` on the command line | Parallel, complementary replies; no Handoff required. |
| One answer depends on the preceding answer | One `@handle` on the command line | Serial baton pass to the responsibility owner. |
| Broad human question | No leading `@handle` | Select up to two non-duplicate opening contributions, then use Handoff only for a concrete unresolved deliverable. |
| No unresolved, responsibility-owned next question | Any route | Stop; do not manufacture a Handoff. |

Routing syntax is intentionally narrow: a handle is a command only at the start
of a line. Mentions in prose are context, not control flow. This follows the
same separation of deterministic routing from model judgment used by
[Clowder's at-mention routing design](https://github.com/zts212653/clowder-ai/blob/main/docs/architecture/at-mention-routing-system.md).

## Live experiments

| ID | Scenario | Observed result | Learning / change |
| --- | --- | --- | --- |
| E1 | Intended product → development → test baton, but later prose named all three agents. | Accidental `multi_direct`; three parallel replies; 0/5 Handoffs accepted. | Inline names must not be routing commands. |
| E2 | Same chain after command-line-only routing. | Product → development completed; development formatted the next mention as prose, so test never ran. | Require an explicit standalone handoff command in public replies. |
| E3 | Explicit handoff command. | Handoff worked, but product chose test instead of development. | A handle needs a compact responsibility roster, not just an address. |
| E4 | Role-informed direct chain. | Product → development → test completed at 3/3 rounds. | A capped serial chain can deliver a real release gate when each pass owns one unresolved question. |
| E5 | Deliberate parallel AI-news review. | Product and development each produced distinct, bounded findings; 0 Handoffs. | Low handoff count is correct for independent work. |
| E6 | Ordinary human launch decision. | Development → product → test reached 3/3, yielding scope, evidence constraints, 100-item validation plan, and Go/No-Go checks. | The handoff policy prevented cycles, but the roster still advertised agents already selected to speak. |
| E7 | Ordinary-question regression after the roster fix. | One high-coverage development response; duplicate check silenced redundant follow-ups; 0 Handoffs and no rejection. | Stop after value is exhausted; do not require every role to speak. |
| E8 | Project-development baton for a safe channel-turn stop control. | Product → development completed at 2/3, yielding acceptance criteria and a soft-stop / bounded hard-cancel design. | A Handoff can be valuable with only two roles when the implementation decision is fully resolved. |
| E9 | Human test review in the E8 thread. | The tester could not see the earlier long product/engineering replies. | Root-turn Agent replies must be discoverable from a later Thread, and context capacity must accommodate a real design proposal. |
| E13 | Clean-thread context regression. | Test accurately restated Product's earlier acceptance condition in a later human Thread reply. | Root-turn reply retrieval works for newly summarized Threads. |

The detailed timestamps, channel IDs, raw outcomes, and each test reflection are
kept in the local QA lab log at `.gstack/qa-reports/multi-agent-experiment-log-2026-08-11.md`.

## Current safeguards

1. **Explicit command grammar.** Only line-leading `@handle` syntax changes
   routing. This removes hidden broadcast fan-out from ordinary discussion.
2. **Responsibility-aware baton.** The response instruction shows roles and asks
   for one unspoken owner of one unresolved question.
3. **Accurate available roster.** Agents already selected or spoken are removed
   from the handoff candidates, avoiding invitations that policy must reject.
4. **One speaker, one contribution.** Duplicate checks run before later opening
   speakers; redundant turns are intentionally silent.
5. **Bounded worklist.** The coordinator rejects self-handoffs, cycles,
   duplicate targets, unavailable agents, and attempts past the three-round
   limit. Explicit parallel broadcasts do not recursively fan out through
   public handoffs.
6. **Observable terminal state.** A turn exposes completed, rejected, failed,
   cancelled, or active Handoffs rather than silently retrying forever.
7. **Thread continuity.** A later human reply can retrieve Agent replies
   produced by the root turn; the conversation context budget is 20,000
   characters so a complete engineering proposal is not immediately evicted.

## What the external evidence changes

- **Shared task + role model:** Team research describes shared mental models as
  common understanding of the goal, roles, and coordination. The roster and
  release gate are therefore control-plane data, not prompt decoration. A study
  of 104 work teams also links task/cooperative goal interdependence and
  distributed expertise coordination with performance. [Shared mental-model
  review](https://pmc.ncbi.nlm.nih.gov/articles/PMC11839146/), [team study](https://pubmed.ncbi.nlm.nih.gov/18020808/)
- **Handoff is a state transition:** AutoGen represents handoff and termination
  as explicit events/conditions, including max-message, timeout, external stop,
  and target-handoff termination. Sinapsis should keep its explicit public
  Handoff record and stop rules rather than infer them from prose. [AutoGen
  termination docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)
- **Evaluate outcomes, not a fixed trace:** Anthropic notes that valid
  multi-agent runs may take different paths, so evaluation needs to judge the
  achieved result and the reasonableness of the process. The E1–E7 log therefore
  records both mechanics (rounds, rejections) and decision quality (new evidence,
  feasibility, testable gates). [Anthropic evaluation guidance](https://www.anthropic.com/engineering/multi-agent-research-system)

## Boundaries and next experiments

- A three-round cap is currently a **safety rail**, not a measure of depth. E4
  and E6 reached a complete, testable decision inside it. Raising the cap should
  require evidence that a legitimate dependency chain cannot be split or
  summarized, not dissatisfaction with message count.
- “No Handoff” is a valid success state for parallel research or a complete
  answer. “Rejected Handoff” should indicate a real policy explanation, not
  missing roster context.
- The next high-value scenarios are: a genuine disagreement that needs a human
  escalation; timeout/cancellation while a handoff is queued; and a project
  implementation turn whose test role verifies an actual repository artifact.
