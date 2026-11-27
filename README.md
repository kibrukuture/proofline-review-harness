# proofline-review-harness

Local proofs for one review evaluation.

The service under test is [support-refunds-service](https://github.com/kibrukuture/support-refunds-service), a small TypeScript backend for a support agent that can issue refunds. Its pull request `#1` contains five real defects and three changes that only look dangerous. This harness proves each one on a throwaway Postgres, with no cloud account, no payment provider and no network call.

It was written against two commits:

| Ref | Commit |
| --- | --- |
| `main` | `e6d5bf20a7ad6550ff062ffbfb6d442ff4b0214f` |
| `feature/refund-creation` | `4b99bad15d9428f30f603121d36188e15f8cd464` |

The proofs read those two commits. On a different commit the script prints a warning, because the expected results only hold for this pair.

## Layout

The harness reads the service by relative path, so the two clones sit beside each other:

```
proofline/
├── support-refunds-service/
└── proofline-review-harness/
```

Set `SERVICE_REPO` to point anywhere else.

## Requirements

- Node 22 or newer, and npm
- Postgres 14 or newer, with `initdb`, `pg_ctl`, `psql`, `createdb` and `dropdb` on `PATH`
- Git and bash

On macOS, `brew install postgresql@14 node` covers it. Homebrew does not put the server tools on `PATH` by default, so add `$(brew --prefix postgresql@14)/bin`.

## Run

Run these five commands from an empty directory. The two clones have to end up as siblings, because the harness reads the service by relative path.

```sh
git clone https://github.com/kibrukuture/support-refunds-service
git clone https://github.com/kibrukuture/proofline-review-harness
(cd support-refunds-service && npm install)
(cd proofline-review-harness && npm install)
./proofline-review-harness/run-all.sh
```

The last command runs from the directory that holds both clones. If you are already inside the harness clone, run `./run-all.sh` instead.

The script creates a temporary database cluster on port 55432, applies the migrations from both commits, runs every check, then stops the cluster and deletes it. While it runs it checks out `feature/refund-creation` inside the service clone and puts your previous branch back when it exits. If that clone has uncommitted changes, the script stops and changes nothing.

It prints one `PASS` or `FAIL` line per check and ends with a line like `database checks: 9 passed, 0 failed`. A `FAIL` means the service is not on the pinned commits, or the Postgres tools are missing.

Useful variables: `PGPORT` for a different port, `PGDATA` for a different cluster directory, `KEEP_PG=1` to leave the cluster running for inspection.

## What it proves

| Check | Claim |
| --- | --- |
| `check-p1.ts` | The API at 8 tasks with a 12 connection pool exceeds 197 connections during a rolling deploy (212), and 232 if both services roll. `main` peaks at 136. |
| `check-static.ts` | The worker policy loses `sqs:ChangeMessageVisibility` while the worker still calls it, `PurgeQueue` is unused on both refs, the payment client stops sending the idempotency key, and the new tool skips the scoped order lookup. |
| `check-p2p4.ts` | The fake queue denies the removed action, the extension stops, and two deliveries of one job produce two payments on the branch against one payment on `main`. |
| `check-p5.ts` | A scripted model refunds another customer's order for 9,900 USD from a session that owns neither. |
| `check-s2.ts` | A `DROP TABLE` payload in the sort parameter is ignored, the table survives, and valid sort keys still work. |
| `check-review-s2.ts` | `sort=constructor`, `__proto__`, `toString`, `hasOwnProperty` and `valueOf` bypass the fallback and break the query. This is the defect the review found that the expected results had missed. |
| `run-all.sh` | The rename leaves the previous revision's query failing with `column "amount" does not exist`; the index swap keeps a valid index and drops the old one; a failed build keeps the old index and is not recorded. |

`expected-results.md` is the key, frozen before the review ran. It states what each planted defect should look like and what counts as caught, partly caught or missed.

## What it does not prove

One service, one pull request, one run. It shows what this reviewer did on this input, not a rate or a general capability. No cloud was connected, so nothing here exercises environment checks. The fake model, queue and payment provider are local stand ins, and the Terraform was never applied.
