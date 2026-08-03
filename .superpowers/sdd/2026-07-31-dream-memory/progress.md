# SDD ledger — plan: docs/superpowers/plans/2026-07-31-dream-memory.md

Baseline: 6ff7df03ea3733e71dcaa224f7a33044ee0127f9
Baseline verification: 51 test files, 444 tests passed; build passed
Task 1: in progress
Task 1 base: 6ff7df03ea3733e71dcaa224f7a33044ee0127f9
Task 1 implementer: Arendt (019fc27b-dbf8-7d22-ae60-4d3d50192fb6)
Task 1 implementation: 269eec6 feat: persist dream memory candidates
Task 1 reviewer: Tesla (019fc285-5cc5-7dd2-8325-c6550b17bb66)
Task 1: fix round 1/5 in progress (3 P1, 1 P3: scope reassignment, cross-channel Global provenance, NULL watermark uniqueness, concurrency/rollback coverage)
Task 1: fix round 1/5 implemented (new-database behavior addressed; commit ac16fff; 453/453 tests)
Task 1: fix round 2/5 in progress (migration 19 immutability/19→20 upgrade; explicit lock-race coverage)
Task 1: fix round 2/5 implemented (commit 3312a34; 454/454 tests)
Task 1: fix round 3/5 in progress (original-19 scope-safe provenance inference; ac16fff-shaped 19 candidate preservation)
Task 1: fix round 3/5 implemented (commit a2b6d9a; 456/456 tests)
Task 1: complete (commits 6ff7df0..a2b6d9a, review clean)
Task 2: in progress
Task 2 base: a2b6d9a5c4ba99c8953f241adcedd6c5ab7b3849
Task 2 implementer: Feynman (019fc2a2-acd0-7250-8483-c69663a64366)
Task 2 takeover: Feynman stalled without code changes after restart
Task 2 implementer: Noether (019fc2a9-0ea6-7ae3-b00e-74b4cc3bb924)
Task 2 takeover: Noether hit model capacity after leaving uncommitted implementation at 102/103 focused tests
Task 2 implementer: Bohr (019fc2af-a5f6-7980-8103-3c321a291c2d)
Task 2 implementation: 1db45dd feat: assemble confirmed memory context
Task 2 reviewer: Galileo (019fc2c6-9c55-7ae0-a9d7-7d1870a1fb3d)
Task 2: fix round 1/5 in progress (6 P1, 2 minor: summary CAS/order, warm invocation envelope, nonblocking refresh, prompt boundary, production wiring, tiny budget, watermark pair constraint)
Task 2: fix round 1/5 implemented (summary CAS/rowid watermark API, warm/resume envelopes, safe JSON boundaries, nonblocking refresh, production rolling generator, exact tiny budgets, migration 22 pair constraints; 487/487 tests; build passed)
Task 2: fix round 2/5 implemented (migration 22 repairs existing half-watermarks; thread Summary single-flight, timeout, AbortSignal and cancellation; commit 56d4627; 489/489 tests; build passed)
Task 2: complete (commits a2b6d9a..56d4627, final scoped review clean)
Task 3: in progress
Task 3 base: 56d4627
Task 3 implementer: Gauss (019fc2ef-5600-7941-bedc-64ac851f77b6)
Task 3 takeover: Gauss stalled without code changes after scope reduction
Task 3 implementer: Beauvoir (019fc2f3-cacf-7171-ab20-9bc9fdcc4686)
Task 3 protocol slice: complete (strict JSON/source/safety/max validation; normalized SHA-256 exports; 20/20 tests)
Task 3 Runtime slice: complete (independent run directory/session, safe public prompt, settled parsing, atomic failure, artifact isolation, duplicate/conflict handling; 18/18 tests)
Task 3 Runtime boundary hardening: complete (read-only one-shot conversation mode, start timeout with late-session cancellation, message/Turn channel provenance, safe runId, constructor bounds, ConversationSessionResult parsed.reply, relevant accepted Memory filtering, subject/key conflicts)
Task 3 config slice: complete (Dream runtime/model/timeout/candidate-limit defaults and validation; 13/13 tests)
Task 3: fix round 1/5 implemented (task mode replaced by read-only one-shot conversation mode; cross-channel Turn and unsafe runId rejected pre-start; constructor validates timeout and candidate bounds; 18/18 Runtime tests)
Task 3 verification: focused 51/51; full suite 54 files and 532/532 tests; build and diff check passed
Task 3: implementation complete; report written; ready for commit
Task 3 commits: 3d574aa feat: consolidate memory candidates safely; 06708e8 fix: isolate dream runtime maintenance
Task 3 reviewer: Maxwell (019fc30a-7273-7913-86d4-c242f95d0b70)
Task 3: fix round 2/5 implemented (commits f6b2417, f16a873; adapter-enforced no-tools, one-shot close, nested turn validation, safer filtering, proposal dedupe, atomic candidate batches)
Task 3 reviewer: Nash (019fc31d-bfee-7cb1-8aa8-e76a4816f460)
Task 3: fix round 3/5 implemented (commit b1b9941; delayed-session cancellation diagnostics, isolated OpenCode config discovery, lowercase AWS credentials and arbitrary-home credential paths)
Task 3 verification: focused 61/61; full suite 54 files and 548/548 tests; build and diff check passed
Task 3/4 final reviewer: Aquinas (019fc52f-3e0a-7ce3-852c-2c26c185d1b9)
Task 4: in review
Task 4 base: b1b9941
Task 4 incremental run queue: 0119e06 feat: queue incremental dream runs
Task 4 daily scheduler/composition: 43fa610 feat: schedule daily dream maintenance
Task 4 verification: focused 6 files and 114/114 tests; final full suite 56 files and 563/563 tests; build and diff check passed
Task 3/4 review round 1: 4 P1, 3 P2 (lowercase AWS filtering, same-millisecond late source, restart recovery, late cancellation evidence, repeated DST time, stop/start generation race, shutdown drain)
Task 3/4 review adjudication: restart recovery is explicitly Task 7 Step 3 and remains scheduled there; all other findings fixed in current round
Task 3/4 fix round 1: source-completion fallback closes late-message gap; late cancel diagnostics persist; DST is once/day; scheduler generations isolate stale callbacks; shutdown drains maintenance
Task 3/4 fix verification: focused 6 files and 118/118 tests; full suite 56 files and 568/568 tests; build and diff check passed
Task 3/4 fix commit: 3681048 fix: harden dream maintenance scheduling
Task 3/4 scoped re-review: Aquinas, clean; restart recovery accepted as Task 7 Step 3
Task 3: complete (commits 56d4627..3681048, review clean)
Task 4: complete (commits b1b9941..3681048, review clean)
Task 5: in progress
Task 5 base: 3681048
