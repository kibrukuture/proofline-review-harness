# Expected results, frozen before the review

Frozen: 2026-11-25, before the repository existed publicly and before any review ran.
Any later correction must be appended under "Corrections", never edited in place.

## Identity

| Item | Value |
| --- | --- |
| Repository | `kibrukuture/support-refunds-service` (public) |
| Baseline | `main` = `e6d5bf20a7ad6550ff062ffbfb6d442ff4b0214f` |
| Pull request head | `feature/refund-creation` = `4b99bad15d9428f30f603121d36188e15f8cd464` |
| Type check | `tsc --noEmit` clean on both refs |
| Tests | `main` 26 pass / 0 fail; branch 28 pass / 0 fail |
| Size | 2,978 lines across `src`, `test`, `scripts`, `migrations`, `terraform`, `docs`, README (excludes `package-lock.json`) |
| Local database | PostgreSQL 14.23, disposable cluster on port 55432 |

Commits on the branch, oldest first:

```
f82e6a7 Rename refunds.amount to amount_cents
4488abc Add an index for the refund history query
ad306f2 Let the support agent create refunds
b4b72e2 Raise the API service to eight tasks
e32e32b Trim the worker SQS policy to the actions it uses
1699172 Simplify the payment provider client
4b99bad Allow sorting the refund list
```

## Scoring rule used

- **Caught**: names the correct failure *and* the correct mechanism. A comment on the same
  line that does not state the failure is **not** caught.
- **Partly caught**: right area, wrong or missing mechanism, or only one half of a two-part
  failure.
- **Missed**: no finding on the relevant behaviour.
- For S1 to S3: a finding is a false alarm only if it claims a failure or vulnerability that the
  evidence disproves. A performance or style remark is not a false alarm.

---

## P1: connection budget during deployment

**Change.** `terraform/variables.tf`: `api_desired_count` 4 → 8.

**Unchanged evidence.** `terraform/ecs.tf` (`deployment_maximum_percent = 200`,
`deployment_minimum_healthy_percent = 100` on both services); `terraform/rds.tf`
(`max_connections = 200`, `superuser_reserved_connections = 3`); `src/config.ts`
(`dbPool.api = 12`, `dbPool.worker = 10`).

**Arithmetic.** 197 available. Branch steady 8×12 + 2×10 = 116. API deploy
16×12 + 20 = 212. Both deploy 192 + 40 = 232. Baseline peaks are 116 and 136.

**Proof.** `check-p1.ts` parses both refs and asserts the four numbers.

**Caught if** the finding states that a rolling API deploy doubles the task count, so the
pool demand (212, or 232 with the worker) exceeds the 197 the database accepts. Mentioning
"more tasks may use more connections" without the limit or the doubling is only partly caught.

**Fairness note.** A pool max is a cap, not observed usage. Worst-case capacity planning is the
correct standard here, but a reviewer could argue the pools rarely saturate.

---

## P2: visibility extension permission removed

**Change.** `terraform/iam.tf`: the `worker_sqs` inline policy loses
`sqs:ChangeMessageVisibility` (and `sqs:PurgeQueue`).

**Unchanged evidence.** `src/worker/visibility.ts` calls `queue.changeVisibility(...)` every
10 s; `src/queue/sqs.ts` sends `ChangeMessageVisibilityCommand`; the task role has no other
SQS policy and no managed SQS policy is attached.

**Consequence.** On AWS the call returns `AccessDenied`. The worker swallows the error and
keeps going, so the message becomes visible again 30 s into a payment call that can take 60 s.

**Proof.** `check-static.ts` (policy vs call site) and `check-p2p4.ts` (fake queue denies the
action; extensions = 0).

**Caught if** it names the removed action and the worker call that needs it, and says the
extension will be denied.

---

## P3: column rename during a rolling deploy

**Change.** `migrations/003_refund_amount_cents.sql` renames `refunds.amount` to
`refunds.amount_cents`; the new code reads and writes the new name.

**Unchanged evidence.** `docs/deployment.md`: the migration task runs to completion *before*
the new application tasks start, while the previous API and worker tasks keep serving.

**Consequence.** Any task on the previous revision issues `SELECT ... amount ...` and fails with
SQLSTATE 42703 (`column "amount" does not exist`) from the moment the migration commits until it
is replaced.

**Proof.** Real Postgres: the old query fails on the migrated schema (see `run.log`).

**Caught if** it connects the rename to the tasks still running the old revision. "Renaming a
column can break queries" without the rollout overlap is only partly caught.

**Note.** There is no down migration, so a rollback to the previous image is also broken.

---

## P4: idempotency key dropped

**Change.** `src/payments/client.ts` is rewritten and no longer sends `idempotency-key`.

**Unchanged evidence.** `docs/payment-contract.md`: duplicate protection works only when the
key is sent; `src/fakes/fake-payment.ts` dedupes only when a key is present;
`src/worker/refund-job.ts` call site is unchanged.

**Consequence.** Any redelivery or retry of the same refund creates a second payment.

**Proof.** `check-p2p4.ts`: two deliveries, two provider requests, two payments; baseline gives
one payment with the same key twice.

**Caught if** it states that a duplicate delivery now pays twice because the key is gone.

---

## P5: refund tool without server-side authorization

**Change.** `src/api/agent/tools/create-refund.ts` (new) takes `orderId` from model output,
calls `store.getOrder(orderId)` (no ownership filter) and applies no amount limit.
`src/api/agent/prompt.ts` states the ownership rule and the 500.00 USD limit in prose only.

**Unchanged evidence.** `src/api/agent/tools/orders.ts` uses `getOrderForCustomer`, so the
scoped pattern exists next to the new tool.

**Consequence.** A manipulated or mistaken model call refunds another customer's order and can
exceed the limit.

**Proof.** `check-p5.ts`: session is customer A, the scripted model refunds customer B's order
for 9,900.00 USD; the refund is created and attributed to B.

**Caught if** it says the new tool does not verify that the order belongs to the session
customer (and/or does not enforce the limit) on the server.

---

## Chain: P2 + P4

A duplicate delivery during a slow payment is expected when the visibility extension is denied;
without the idempotency key that duplicate pays twice. **Bonus**: credit if a single finding or
a linked pair states this path. Not required for P2 or P4 credit.

---

## S1: index replacement (safe)

`migrations/002_refund_list_index.sql` builds `(customer_id, created_at)` concurrently, checks
`indisvalid`, and only then drops `(customer_id)`. `scripts/migrate.ts` honours
`-- migrate:no-transaction` and sends statements one at a time.

Safe because the new index has the same leading column, so it serves every lookup the old index
served, including `ORDER BY created_at` (forward and backward scans).

Proof: new index valid, old index gone, plan uses the new index; with an invalid leftover index
the guard raises, the runner stops, the old index survives and the migration is not recorded.

**False alarm if** it claims the migration will fail inside a transaction (it has the directive),
that the old index is dropped before validation (the guard runs first), or that the customer
lookups lose their index.

---

## S2: ORDER BY from an allowlist (safe)

`src/store/pg.ts` maps `sort` through `REFUND_SORT_COLUMNS` with a fixed default and maps
`direction` to `ASC`/`DESC`; `customer_id` and `limit` stay parameters. The sort string reaches
the store from the request and the model, so it looks like injection input.

Proof: a `DROP TABLE` payload is ignored, the table survives, valid keys still sort, unknown
keys fall back.

**False alarm if** it claims SQL injection or data loss.

---

## S3: unused permission removed (safe)

`sqs:PurgeQueue` is removed from the worker policy. `git grep` finds no reference in code,
scripts or docs on either ref, and the queue abstraction has no purge method.

**False alarm if** it claims something calls `PurgeQueue` or that a runbook depends on it.

---

## Unplanned findings to verify separately

- **U1** `createRefund` never checks how much of an order has already been refunded and never
  updates `orders.status`. The same order can be refunded repeatedly, each creating a payment.
  Real, present on the branch only.
- **U2** `createRefund` accepts a zero or negative amount; the database `CHECK (amount > 0)`
  rejects it and the tool returns an error string. Minor, not a payment risk.
- **U3** The API and worker both write `refunds.status` without a compare-and-set; two
  concurrent deliveries can interleave `processing` and `succeeded`. Covered by P4 in effect.

## Corrections

- 2026-11-25, after the first review was saved and during scoring: **S2 was not safe.** The key
  said the sort allowlist made the dynamic `ORDER BY` safe. It does not. `REFUND_SORT_COLUMNS` is
  a plain object literal, so `sort=constructor`, `sort=toString`, `sort=hasOwnProperty`,
  `sort=valueOf` or `sort=__proto__` resolves an inherited property, bypasses the
  `?? "created_at"` fallback, and interpolates a function or object into `ORDER BY`. The query
  fails with a syntax error and `GET /refunds` returns 500. Reproduced for all five keys against
  the local database. This is not SQL injection (no attacker-controlled text reaches the query),
  but the fallback bypass and the 500 are real. The key was wrong.
- 2026-11-25, same session: **S1 is safe in practice, but its guard is weaker than the key said.**
  The `DO` block checks only `indisvalid` for the index name, not the index's table or columns.
  The failure needs a valid index of that name on another table, which no migration creates, so it
  cannot happen in this schema. "The guard runs before the drop" remains true.
- Note for the record: the 197 connection ceiling also appears in `docs/architecture.md` line 45,
  not just in Terraform, so P1's evidence is easier to reach than the key implied.
- 2026-11-25, before freeze: the baseline `aws_db_instance` used an AWS-managed master password
  while `DATABASE_URL` was built from `var.db_password`, which would not have matched. Replaced
  with `password = var.db_password` and the `main` commit amended before publishing.
- 2026-11-25, before freeze: the sort change was planned for the PR but initially missing;
  added as a separate commit (`Allow sorting the refund list`) before the key was frozen.
