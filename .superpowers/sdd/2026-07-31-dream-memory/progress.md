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
