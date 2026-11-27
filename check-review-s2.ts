import pg from "pg";

import { PgStore } from "../support-refunds-service/src/store/pg.js";
import { assert, check, finish } from "./lib.js";

const url = process.env.DATABASE_URL;
if (url === undefined) {
  console.log("SKIP  set DATABASE_URL to a migrated database");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
const store = new PgStore(pool);

// Any inherited property name resolves through the prototype of the plain
// object used as the sort map, bypasses the fallback, and reaches ORDER BY.
const inherited = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

for (const sort of inherited) {
  let failed = false;
  try {
    await store.listRefunds("11111111-1111-4111-8111-111111111111", {
      sort,
      direction: "desc",
      limit: 2,
    });
  } catch {
    failed = true;
  }
  check(`sort=${sort} reaches the database and fails`, () => {
    assert(failed, `sort=${sort} was accepted, which means the fallback caught it`);
  });
}

await pool.end();
finish();
