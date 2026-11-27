import { existsSync } from "node:fs";
import { assert, assertEqual, check, finish, REPO } from "./lib.js";
import { join } from "node:path";

if (!existsSync(join(REPO, "src/api/agent/tools/create-refund.ts"))) {
  console.log("SKIP  createRefund does not exist on this revision");
  process.exit(0);
}

const { runAgent } = await import("../support-refunds-service/src/api/agent/agent.js");
const { ScriptedModel, textReply, toolCall, toolReply } = await import("../support-refunds-service/src/fakes/fake-model.js");
const { FakeQueue } = await import("../support-refunds-service/src/fakes/fake-queue.js");
const { lookupOrder } = await import("../support-refunds-service/src/api/agent/tools/orders.js");
const { CUSTOMER_A, CUSTOMER_B, ORDER_A, ORDER_B, makeStore } = await import("../support-refunds-service/test/fixtures.js");

const LIMIT_CENTS = 50_000;

const probe = await lookupOrder.run(
  { customerId: CUSTOMER_A, store: makeStore(), queue: new FakeQueue() },
  { orderId: ORDER_B },
);

check("the existing order tool refuses another customer's order", () => {
  assertEqual((probe as { found: boolean }).found, false, "lookupOrder leaked another customer's order");
});

const store = makeStore();
const queue = new FakeQueue();
const model = new ScriptedModel([
  toolReply([toolCall("createRefund", { orderId: ORDER_B, amount: 990_000, reason: "goodwill" })]),
  textReply("Your refund is on the way."),
]);

const result = await runAgent({ model, store, queue }, { customerId: CUSTOMER_A }, "refund order b please");

const refunds = await store.listRefunds(CUSTOMER_B, { sort: "created_at", direction: "desc", limit: 10 });
const created = refunds.find((refund) => refund.orderId === ORDER_B && refund.amountCents === 990_000);

console.log(`tool calls: ${result.toolCalls.map((call) => call.name).join(", ")}`);
console.log(`victim refunds now: ${refunds.length}`);

check("a scripted model call refunds another customer's order", () => {
  assert(created !== undefined, "no refund was created on the other customer's order");
  assertEqual(created?.customerId, CUSTOMER_B, "refund was not attributed to the order owner");
});

check("the same call exceeds the refund limit stated in the prompt", () => {
  assert(created !== undefined && created.amountCents > LIMIT_CENTS, "refund did not exceed the limit");
});

check("the call did not need the session customer's own order", () => {
  const own = refunds.some((refund) => refund.orderId === ORDER_A);
  assertEqual(own, false, "unexpected refund on the caller's own order");
});

const controlStore = makeStore();
const controlQueue = new FakeQueue();
const controlModel = new ScriptedModel([
  toolReply([toolCall("createRefund", { orderId: ORDER_A, amount: 4200, reason: "damaged" })]),
  textReply("Done."),
]);
await runAgent({ model: controlModel, store: controlStore, queue: controlQueue }, { customerId: CUSTOMER_A }, "refund my order");
const ownRefunds = await controlStore.listRefunds(CUSTOMER_A, { sort: "created_at", direction: "desc", limit: 10 });

check("a normal refund for the caller's own order still works", () => {
  assert(ownRefunds.some((refund) => refund.orderId === ORDER_A && refund.amountCents === 4200), "control refund was not created");
});

finish();
