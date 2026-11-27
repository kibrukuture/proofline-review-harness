import { randomUUID } from "node:crypto";

import pg from "pg";

import { PgStore } from "../support-refunds-service/src/store/pg.js";
import { assert, assertEqual, check, finish, readRepo } from "./lib.js";

const url = process.env.DATABASE_URL;
if (url === undefined) {
  console.log("SKIP  set DATABASE_URL to a migrated database");
  process.exit(0);
}

const source = readRepo("src/store/pg.ts");
const pool = new pg.Pool({ connectionString: url, max: 2 });
const store = new PgStore(pool);

const customerId = randomUUID();
const orderId = randomUUID();

await pool.query(`INSERT INTO customers (id, email) VALUES ($1, $2)`, [customerId, `${customerId}@example.test`]);
await pool.query(`INSERT INTO orders (id, customer_id, amount) VALUES ($1, $2, 1000)`, [orderId, customerId]);
for (const amount of [300, 100, 200]) {
  await pool.query(
    `INSERT INTO refunds (order_id, customer_id, amount_cents, currency, status, reason)
     VALUES ($1, $2, $3, 'usd', 'succeeded', 'sort test')`,
    [orderId, customerId, amount],
  );
}

check("the sort keys are resolved from a fixed map", () => {
  assert(source.includes("REFUND_SORT_COLUMNS"), "no column allowlist in the store");
  assert(source.includes("ORDER BY ${column} ${direction}"), "ORDER BY is not built from the map");
});

check("all values are parameterised", () => {
  assert(source.includes("WHERE customer_id = $1"), "customer id is not a parameter");
  assert(source.includes("LIMIT $2"), "limit is not a parameter");
});

const injected = await store.listRefunds(customerId, {
  sort: "created_at; DROP TABLE refunds; --",
  direction: "desc; DROP TABLE refunds",
  limit: 2,
});

check("a malicious sort value is ignored instead of executed", () => {
  assertEqual(injected.length, 2, "row count");
});

const survived = await pool.query<{ name: string | null }>(
  `SELECT to_regclass('public.refunds')::text AS name`,
);

check("the refunds table still exists", () => {
  assert(survived.rows[0]?.name === "refunds", "refunds table is gone");
});

const ascending = await store.listRefunds(customerId, { sort: "amount", direction: "asc", limit: 3 });
const amounts = ascending.map((refund) => refund.amountCents);

check("the amount sort key and direction still work", () => {
  assertEqual(amounts.join(","), "100,200,300", "unexpected ordering");
});

const fallback = await store.listRefunds(customerId, { sort: "not_a_column", direction: "sideways", limit: 3 });

check("an unknown key falls back to the default ordering", () => {
  assertEqual(fallback.length, 3, "row count");
});

await pool.end();
finish();
