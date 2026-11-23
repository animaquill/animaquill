import { randomBytes } from "node:crypto";
import { GB, type LibraryConfig, type LibraryStorageConfig } from "../library/config.ts";

/**
 * An object storage for the tests that need one: `AQ_TEST_S3`, the address of a versitygw that is
 * only for tests, as CI starts one (see vitest.config.ts), with
 * its root key in `AQ_TEST_S3_ACCESS_KEY` and `AQ_TEST_S3_SECRET_KEY`. It checks every signature and
 * checksum as the deployed one does. Each test makes buckets of its own, which go with the storage.
 * Without the variable those tests are skipped.
 */
export const TEST_S3 = process.env["AQ_TEST_S3"];

export const testBucketName = () => `aq-test-${randomBytes(6).toString("hex")}`;

/** The test storage, as the platform's settings would have it. */
export const testStorageConfig = (
  options: Partial<LibraryStorageConfig> = {},
): LibraryStorageConfig => ({
  endpoint: TEST_S3!,
  publicEndpoint: TEST_S3!,
  region: "us-east-1",
  bucket: testBucketName(),
  pathStyle: true,
  prefix: "library/",
  accessKeyId: process.env["AQ_TEST_S3_ACCESS_KEY"] ?? "",
  secretAccessKey: process.env["AQ_TEST_S3_SECRET_KEY"] ?? "",
  ...options,
});

/** The settings of the cloud space around it, with no floor of free disk unless told. */
export const testLibraryConfig = (
  storage: LibraryStorageConfig | undefined,
  options: Partial<LibraryConfig> = {},
): LibraryConfig => ({
  mode: "on",
  storage,
  checksum: "sha256",
  verify: "always",
  totalBytes: 45 * GB,
  minFreeBytes: 0,
  problems: [],
  ...options,
});
