# Import eval

Runs the plan import (`runImport`, one structured-output call on the app key's `outline` model, then `convertDraft`) on
the five files in `fixtures/` and checks each answer in code (`checks.ts`): an 8-week plan with Week 1's rows sorted
right, a 3-month plan, a 4-week plan with one skipped section, and two files (a syllabus and a reading list) that
must come back as `no_plan`. It spends real money, about $1 a run, so run it on demand; nothing here runs in CI.
`npx tsx evals/import/run.ts` needs `AI_GATEWAY_API_KEY` in `.env.local`, prints each fixture's verdicts and cost, and
writes `evals/results/import-<date>.json` (gitignored). The categories of Week 1's non-LeetCode rows are reported as
notes, not failures, since more than one answer is sensible.
