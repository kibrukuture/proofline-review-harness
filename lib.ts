import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * The service repository. Defaults to a sibling directory named
 * support-refunds-service, which is what `git clone` creates.
 */
export const REPO = resolve(
  process.env.SERVICE_REPO ?? resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "support-refunds-service"),
);

export interface Refs {
  readonly base: string;
  readonly head: string;
}

/**
 * Resolves the two refs the proofs compare. A fresh clone only has `main` as a
 * local branch, so the feature branch is read from the remote tracking ref.
 */
export function gitRefs(): Refs {
  const base = "main";
  for (const candidate of ["feature/refund-creation", "origin/feature/refund-creation"]) {
    try {
      execFileSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", candidate], { stdio: "pipe" });
      return { base, head: candidate };
    } catch {
      // try the next name
    }
  }
  throw new Error(
    `cannot find feature/refund-creation in ${REPO}. Fetch the branch or set SERVICE_REPO.`,
  );
}

let failures = 0;

export function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function finish(): void {
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}

export function gitShow(ref: string, path: string): string {
  return execFileSync("git", ["-C", REPO, "show", `${ref}:${path}`], { encoding: "utf8" });
}

export function readRepo(path: string): string {
  return readFileSync(resolve(REPO, path), "utf8");
}

export function varDefault(tf: string, name: string): number {
  const pattern = new RegExp(
    `variable "${name}" \\{\\s*type\\s*=\\s*number\\s*default\\s*=\\s*(\\d+)`,
  );
  const match = pattern.exec(tf);
  if (match?.[1] === undefined) {
    throw new Error(`variable ${name} not found`);
  }
  return Number(match[1]);
}

export function allMatches(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

export function policyActions(iam: string, name: string): string[] {
  const start = iam.indexOf(`resource "aws_iam_policy" "${name}"`);
  if (start < 0) {
    return [];
  }
  const block = iam.slice(start);
  const match = /Action\s*=\s*\[([\s\S]*?)\]/.exec(block);
  if (match?.[1] === undefined) {
    return [];
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].flatMap((item) => (item[1] === undefined ? [] : [item[1]]));
}

export function poolSizes(config: string): { api: number; worker: number } {
  const match = /dbPool:\s*\{\s*api:\s*(\d+),\s*worker:\s*(\d+)/.exec(config);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("pool sizes not found");
  }
  return { api: Number(match[1]), worker: Number(match[2]) };
}
