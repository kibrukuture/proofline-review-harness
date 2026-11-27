import { execFileSync } from "node:child_process";
import { REPO, assert, check, finish, gitRefs, gitShow, policyActions } from "./lib.js";

const { base: MAIN, head: BRANCH } = gitRefs();

function has(ref: string, path: string): boolean {
  try {
    gitShow(ref, path);
    return true;
  } catch {
    return false;
  }
}

function grepCount(ref: string, pattern: string): number {
  try {
    const out = execFileSync(
      "git",
      ["-C", REPO, "grep", "-n", "-e", pattern, ref, "--", ":(exclude)terraform/iam.tf"],
      { encoding: "utf8" },
    );
    return out.trim().length === 0 ? 0 : out.trim().split("\n").length;
  } catch {
    return 0;
  }
}

const mainWorkerActions = policyActions(gitShow(MAIN, "terraform/iam.tf"), "worker_sqs");
const branchWorkerActions = policyActions(gitShow(BRANCH, "terraform/iam.tf"), "worker_sqs");

console.log(`main worker actions:   ${mainWorkerActions.join(", ")}`);
console.log(`branch worker actions: ${branchWorkerActions.join(", ")}`);

check("main grants the visibility action the worker calls", () => {
  assert(mainWorkerActions.includes("sqs:ChangeMessageVisibility"), "main policy is missing sqs:ChangeMessageVisibility");
});

check("branch removes the visibility action while the worker still calls it", () => {
  assert(!branchWorkerActions.includes("sqs:ChangeMessageVisibility"), "branch policy still grants it");
  const worker = gitShow(BRANCH, "src/worker/visibility.ts");
  assert(worker.includes("queue.changeVisibility("), "worker no longer calls changeVisibility");
});

check("main grants PurgeQueue", () => {
  assert(mainWorkerActions.includes("sqs:PurgeQueue"), "main policy does not grant PurgeQueue");
});

check("no code, script or document references PurgeQueue on either ref", () => {
  for (const ref of [MAIN, BRANCH]) {
    const count = grepCount(ref, "PurgeQueue");
    assert(count === 0, `${ref} has ${count} references to PurgeQueue outside the policy`);
  }
});

check("branch drops PurgeQueue from the policy", () => {
  assert(!branchWorkerActions.includes("sqs:PurgeQueue"), "branch policy still grants PurgeQueue");
});

const mainClient = gitShow(MAIN, "src/payments/client.ts");
const branchClient = gitShow(BRANCH, "src/payments/client.ts");

check("main sends an idempotency key derived from the refund id", () => {
  assert(mainClient.includes('"idempotency-key"'), "main client has no idempotency-key header");
  assert(mainClient.includes("refund-${refundId}"), "main key is not derived from the refund id");
});

check("branch no longer sends an idempotency key", () => {
  assert(!branchClient.includes("idempotency-key"), "branch client still sends the header");
});

check("the payment contract still requires the key", () => {
  const contract = gitShow(BRANCH, "docs/payment-contract.md");
  assert(contract.includes("Duplicate protection works only when the key is sent"), "contract text missing");
});

check("the branch migration renames the refund amount column", () => {
  const migration = gitShow(BRANCH, "migrations/003_refund_amount_cents.sql");
  assert(migration.includes("RENAME COLUMN amount TO amount_cents"), "rename not found");
});

check("main has no createRefund tool", () => {
  assert(!has(MAIN, "src/api/agent/tools/create-refund.ts"), "create-refund.ts exists on main");
});

check("branch adds createRefund without an ownership lookup", () => {
  const tool = gitShow(BRANCH, "src/api/agent/tools/create-refund.ts");
  assert(tool.includes("store.getOrder("), "tool does not use getOrder");
  assert(!tool.includes("getOrderForCustomer"), "tool uses the scoped lookup");
});

finish();
