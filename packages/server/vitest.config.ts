import { defineConfig } from "vitest/config";

/**
 * The server's tests. Those that need a PostgreSQL or an object storage skip without them: with
 * AQ_TEST_DATABASE (a database the tests may make databases in, such as
 * postgres://test:test@127.0.0.1:5432/test) and AQ_TEST_S3 (with AQ_TEST_S3_ACCESS_KEY and
 * AQ_TEST_S3_SECRET_KEY, an S3 such as versitygw) they run, as CI runs them (.github/workflows/ci.yml,
 * the job "server"). The tests of saving to GitHub also need Git.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Most tests here work with a database, many times over, and some start threads that load the
    // editor's code to export a project. What they wait for are answers, not a time: the time is only
    // how long a test may take at most, which on a busy machine is more than the usual five seconds.
    testTimeout: 30_000,
    // Making a database of their own, from the migrations.
    hookTimeout: 60_000,
  },
});
