import { allMatches, assert, assertEqual, check, finish, gitRefs, gitShow, poolSizes, varDefault } from "./lib.js";

const { base: MAIN, head: BRANCH } = gitRefs();

interface Capacity {
  readonly apiTasks: number;
  readonly workerTasks: number;
  readonly apiPool: number;
  readonly workerPool: number;
  readonly available: number;
  readonly steady: number;
  readonly apiDeploy: number;
  readonly bothDeploy: number;
}

function capacity(ref: string): Capacity {
  const variables = gitShow(ref, "terraform/variables.tf");
  const ecs = gitShow(ref, "terraform/ecs.tf");
  const config = gitShow(ref, "src/config.ts");

  const apiTasks = varDefault(variables, "api_desired_count");
  const workerTasks = varDefault(variables, "worker_desired_count");
  const maxConnections = varDefault(variables, "db_max_connections");
  const reserved = varDefault(variables, "db_reserved_connections");
  const pools = poolSizes(config);

  const maxPercents = allMatches(ecs, /deployment_maximum_percent\s*=\s*(\d+)/g);
  const minPercents = allMatches(ecs, /deployment_minimum_healthy_percent\s*=\s*(\d+)/g);

  assertEqual(maxPercents.length, 2, `${ref}: two services declare deployment_maximum_percent`);
  assertEqual(minPercents.length, 2, `${ref}: two services declare deployment_minimum_healthy_percent`);
  for (const value of maxPercents) {
    assertEqual(value, 200, `${ref}: deployment_maximum_percent`);
  }
  for (const value of minPercents) {
    assertEqual(value, 100, `${ref}: deployment_minimum_healthy_percent`);
  }

  const available = maxConnections - reserved;
  const steady = apiTasks * pools.api + workerTasks * pools.worker;
  const apiDeploy = apiTasks * 2 * pools.api + workerTasks * pools.worker;
  const bothDeploy = apiTasks * 2 * pools.api + workerTasks * 2 * pools.worker;

  return { apiTasks, workerTasks, apiPool: pools.api, workerPool: pools.worker, available, steady, apiDeploy, bothDeploy };
}

function table(c: Capacity): string {
  return [
    `api tasks ${c.apiTasks}, worker tasks ${c.workerTasks}`,
    `pools ${c.apiPool} / ${c.workerPool}`,
    `available ${c.available}`,
    `steady ${c.steady}`,
    `api deploy peak ${c.apiDeploy}`,
    `both deploy peak ${c.bothDeploy}`,
  ].join(" | ");
}

const base = capacity(MAIN);
const pr = capacity(BRANCH);

console.log(`main:   ${table(base)}`);
console.log(`branch: ${table(pr)}`);

check("main stays inside the connection budget in every case", () => {
  assert(base.steady <= base.available, `steady ${base.steady} > ${base.available}`);
  assert(base.apiDeploy <= base.available, `api deploy ${base.apiDeploy} > ${base.available}`);
  assert(base.bothDeploy <= base.available, `both deploy ${base.bothDeploy} > ${base.available}`);
});

check("branch stays inside the budget at steady state", () => {
  assert(pr.steady <= pr.available, `steady ${pr.steady} > ${pr.available}`);
});

check("branch exceeds the budget during an API deployment", () => {
  assert(pr.apiDeploy > pr.available, `api deploy ${pr.apiDeploy} <= ${pr.available}`);
});

check("branch exceeds the budget when both services deploy", () => {
  assert(pr.bothDeploy > pr.available, `both deploy ${pr.bothDeploy} <= ${pr.available}`);
});

check("only the API task count changed between main and branch", () => {
  assertEqual(pr.workerTasks, base.workerTasks, "worker task count");
  assertEqual(pr.apiPool, base.apiPool, "api pool size");
  assertEqual(pr.workerPool, base.workerPool, "worker pool size");
  assertEqual(pr.available, base.available, "available connections");
});

finish();
