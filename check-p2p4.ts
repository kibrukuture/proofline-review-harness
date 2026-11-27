import { assert, assertEqual, check, finish, policyActions, readRepo } from "./lib.js";
import { FakeQueue } from "../support-refunds-service/src/fakes/fake-queue.js";
import { FakePaymentProvider, fakePaymentsFetch } from "../support-refunds-service/src/fakes/fake-payment.js";
import { HttpPaymentClient } from "../support-refunds-service/src/payments/client.js";
import { processRefundMessage } from "../support-refunds-service/src/worker/refund-job.js";
import { REFUND_B, makeStore } from "../support-refunds-service/test/fixtures.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const actions = policyActions(readRepo("terraform/iam.tf"), "worker_sqs");
const visibilityGranted = actions.includes("sqs:ChangeMessageVisibility");

console.log(`worker policy: ${actions.join(", ")}`);

// The payment call is held open so that a second delivery can run while it is
// still in flight, as SQS does when a job outlives the visibility timeout.
let releasePayments: () => void = () => undefined;
const gate = new Promise<void>((resolve) => {
  releasePayments = resolve;
});

const provider = new FakePaymentProvider();
const innerFetch = fakePaymentsFetch(provider);
const gatedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  await gate;
  return innerFetch(input, init);
}) as typeof fetch;

const payments = new HttpPaymentClient("http://payments.test", gatedFetch);
const store = makeStore();
const queue = new FakeQueue();
if (!visibilityGranted) {
  queue.denied.add("sqs:ChangeMessageVisibility");
}
queue.enqueue(JSON.stringify({ refundId: REFUND_B }));

const deps = { store, payments, queue, heartbeat: { intervalMs: 5, extensionSeconds: 30 } };

const deliver = async (): Promise<void> => {
  const message = await queue.receive();
  assert(message !== null, "expected a delivery");
  await processRefundMessage(deps, message);
};

const first = deliver();
await sleep(40);

const heartbeatCalls = queue.visibilityCalls.length;

// The payment is still running, so the 30 second timeout has passed.
queue.expireVisibility();
const second = deliver();
releasePayments();
await Promise.all([first, second]);

const requests = provider.requests.length;
const charged = provider.payments.length;
const keys = provider.requests.map((request) => request.idempotencyKey ?? "<none>");

console.log(`heartbeat extensions: ${heartbeatCalls}`);
console.log(`provider requests: ${requests}, payments: ${charged}, keys: ${keys.join(", ")}`);

check("the worker extends visibility when the policy allows it", () => {
  if (visibilityGranted) {
    assert(heartbeatCalls > 0, "no visibility extension was sent");
  } else {
    assertEqual(heartbeatCalls, 0, "the fake queue accepted an action the policy removes");
  }
});

check("a duplicate delivery reaches the provider twice", () => {
  assertEqual(requests, 2, "provider request count");
});

check("duplicate deliveries produce one payment when the key is sent", () => {
  if (visibilityGranted) {
    assertEqual(charged, 1, "payment count");
    assert(keys.every((key) => key !== "<none>"), "a request was sent without a key");
    assertEqual(new Set(keys).size, 1, "keys differ between deliveries");
  } else {
    console.log("      (skipped: this revision removes the header)");
  }
});

check("duplicate deliveries produce two payments when the key is missing", () => {
  if (visibilityGranted) {
    console.log("      (not applicable on this revision)");
    return;
  }
  assertEqual(charged, 2, "payment count");
  assert(keys.every((key) => key === "<none>"), "a request still carried a key");
});

finish();
