import { S3Bucket, type S3CorsRule, type S3Options } from "@animaquill/host/s3";
import type { LibraryConfig, LibraryStorageConfig } from "./config.ts";

/**
 * The storage of the cloud space, seen from the platform: the same bucket twice, as the platform
 * reaches it itself (`internal`, such as http://storage:7070 on the Docker network) and as browsers
 * do (`public`, https://objects.example.com): addresses are signed for the host they go to, so
 * those for browsers come from `public`, and the platform's own requests go through `internal`.
 *
 * Where things are in it, all under the prefix (`library/`):
 *
 * - `u/<user id>/<SHA-256 in hexadecimal>`: what people store, one copy of each file a person has,
 *   from step 14.4 on.
 * - `.animaquill-sentinel`: written by `storage setup`. While it is there, the bucket is the one that
 *   was set up, with what it had: a folder of the storage that was emptied or replaced loses it.
 * - `.animaquill-check/<random>`: what `storage check` writes, reads and takes away again.
 *
 * Outside the prefix, in the same bucket: `chat-images/u/<user id>/<SHA-256>`, the pictures of
 * people's conversations (me/chat-images.ts), which are not files of the cloud space.
 */
export class LibraryStorage {
  readonly internal: S3Bucket;
  readonly public: S3Bucket;
  readonly prefix: string;
  readonly config: LibraryStorageConfig;

  constructor(config: LibraryStorageConfig, options: S3Options = {}) {
    this.config = config;
    const target = {
      region: config.region,
      bucket: config.bucket,
      pathStyle: config.pathStyle,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    this.internal = new S3Bucket({ ...target, endpoint: config.endpoint }, options);
    this.public = new S3Bucket({ ...target, endpoint: config.publicEndpoint }, options);
    this.prefix = config.prefix;
  }

  /** The storage of these settings, or undefined when there is none. */
  static of(config: LibraryConfig, options?: S3Options): LibraryStorage | undefined {
    return config.storage && new LibraryStorage(config.storage, options);
  }

  get sentinelKey(): string {
    return `${this.prefix}.animaquill-sentinel`;
  }

  /** Where `storage check` puts what it writes and takes away again. */
  checkKey(name: string): string {
    return `${this.prefix}.animaquill-check/${name}`;
  }

  /** Where people's files are, each person's under `u/<user id>/`. */
  get userPrefix(): string {
    return `${this.prefix}u/`;
  }

  /** Where a file of a person is: by its SHA-256, in hexadecimal. */
  objectKey(userId: string, sha256: string): string {
    if (!/^[0-9a-f-]{36}$/.test(userId) || !/^[0-9a-f]{64}$/.test(sha256))
      throw new RangeError("not a user id and a SHA-256");
    return `${this.userPrefix}${userId}/${sha256}`;
  }
}

/** The headers a page of the editor sends to the storage besides the usual ones. */
export const UPLOAD_HEADERS = ["x-amz-checksum-sha256", "content-type", "range"] as const;

/**
 * What the bucket lets pages of the editor do (`storage setup`): upload parts and read objects with
 * addresses the platform signed, and read the ETag of each part, which completing an upload needs.
 * Nothing else: listing, deleting and completing are the platform's.
 */
export const corsRules = (origins: readonly string[]): S3CorsRule[] => [
  {
    allowedOrigins: [...origins],
    allowedMethods: ["PUT", "GET", "HEAD"],
    allowedHeaders: [...UPLOAD_HEADERS],
    exposeHeaders: ["ETag", "x-amz-checksum-sha256", "Content-Range", "Accept-Ranges"],
    maxAgeSeconds: 3600,
  },
];
