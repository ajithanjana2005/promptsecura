// Minimal typings for the Node built-ins used by the tests, so the project
// does not need @types/node (tests are bundled by esbuild and run by Node).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
  }
  const assert: Assert;
  export default assert;
}
