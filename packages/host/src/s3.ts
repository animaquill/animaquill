import { AwsV4Signer } from "aws4fetch";

/**
 * A small client of S3 and of the storage services that speak its API (Cloudflare R2, Aliyun OSS,
 * Tencent COS, versitygw and the like), the same in the browser and in Node: a platform such as
 * AnimaQuill Cloud keeps its cloud space with it, and the editor uses it for people's own storage.
 *
 * Requests are signed with AWS Signature Version 4 by aws4fetch (MIT, no dependencies), where a
 * mistake is easiest to make and hardest to see; what is here is the thin layer of operations over
 * it, and the little XML they need. Nothing here retries, keeps or logs anything: callers know what is
 * worth trying again. Errors are `S3Error`, never with a key or a signature in them.
 *
 * Keys are made of letters, digits and `._-/` only, in parts between slashes that are never empty,
 * `.` or `..`: those every service, every step of encoding and aws4fetch's own handling of paths
 * take the same way. Content here is named by its hash anyway.
 */

export interface S3Target {
  /** Where the service is: its scheme and host, and a port if any, no path. */
  readonly endpoint: string;
  /** Such as us-east-1, or auto for R2. Signatures are made for it. */
  readonly region: string;
  readonly bucket: string;
  /**
   * Addresses like endpoint/bucket/key ("path-style"), or bucket.endpoint/key. Path-style is what
   * a service of one's own takes; some services take only the other.
   */
  readonly pathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** For credentials that come with one. */
  readonly sessionToken?: string | undefined;
}

export interface S3Options {
  /** In place of the global fetch, as for tests. */
  readonly fetch?: typeof fetch;
  /** How long a request may take, unless an operation is told otherwise. */
  readonly timeoutMs?: number;
  /** The clock that signatures go by. */
  readonly now?: () => Date;
}

/** What went wrong, with what the service said: its HTTP status and its code, such as NoSuchKey. */
export class S3Error extends Error {
  override name = "S3Error";
  /** The operation, such as "completeUpload". */
  readonly operation: string;
  /** The HTTP status, or 0 when no answer came. */
  readonly status: number;
  /**
   * S3's code, such as SignatureDoesNotMatch; `HTTP <status>` when the answer had none; and,
   * without an answer, "Unreachable", "Timeout", or "Redirect" for an answer that sent the
   * request elsewhere, which a wrong region or address does.
   */
  readonly code: string;

  constructor(
    operation: string,
    status: number,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

/** The largest part, or object in one request, that addresses are signed for. */
export const MAX_PART_BYTES = 64 * 1024 * 1024;
/** S3's rules for uploads in parts: every part but the last has at least this many bytes. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;
/** ... and there are at most this many parts. */
export const MAX_PARTS = 10_000;
/** How long a signed address can work at most: a week, as SigV4 has it. */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
/** What a request may take unless told otherwise. */
export const S3_TIMEOUT_MS = 30_000;
/**
 * What completing an upload may take unless told otherwise: a service that keeps objects as files
 * copies the parts into one, which took about ten seconds a GiB on a small server.
 */
export const COMPLETE_TIMEOUT_MS = 15 * 60_000;
/** The largest XML answer that is read. A page of a listing is a few hundred KB. */
const MAX_XML_BYTES = 8 * 1024 * 1024;

const KEY_PART = /^[A-Za-z0-9._-]+$/;

/** Whether this is a key this module takes, see the top of this file. At most 1024 characters. */
export const isSafeKey = (key: string): boolean =>
  key.length > 0 &&
  key.length <= 1024 &&
  key.split("/").every((part) => KEY_PART.test(part) && part !== "." && part !== "..");

/** A prefix of keys: nothing, or a safe key and a slash, such as `library/`. */
export const isSafePrefix = (prefix: string): boolean =>
  prefix === "" || (prefix.endsWith("/") && isSafeKey(prefix.slice(0, -1)));

/**
 * A bucket's name as S3 has it: 3 to 63 lowercase letters, digits, dots and hyphens, starting and
 * ending with a letter or a digit, and not like an IP address.
 */
export const isBucketName = (name: string): boolean =>
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) &&
  !name.includes("..") &&
  !/^\d+\.\d+\.\d+\.\d+$/.test(name);

/** What is wrong with an address of a service, or undefined: only http(s), a host and a port. */
export const endpointProblem = (text: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "is not an address";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "has to be http or https";
  if (url.username || url.password) return "has to be without a name or password";
  if (url.origin !== text.replace(/\/$/, "")) return "has to be only the scheme and host, no path";
  return undefined;
};

const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A rule of a bucket for pages of other sites, as S3 has them. */
export interface S3CorsRule {
  readonly allowedOrigins: readonly string[];
  readonly allowedMethods: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly exposeHeaders: readonly string[];
  readonly maxAgeSeconds?: number | undefined;
}

/** An object, as HEAD says it is. */
export interface S3ObjectInfo {
  readonly size: number;
  readonly etag: string;
  readonly contentType: string | undefined;
  readonly lastModified: Date | undefined;
  /**
   * What the service keeps of a SHA-256 of it, base64: of the whole object, or, for one uploaded in
   * parts, of the parts' (then it ends with `-<parts>`). Undefined where the service keeps none.
   */
  readonly checksumSha256: string | undefined;
}

export interface S3ListedObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: Date | undefined;
}

export interface S3Upload {
  readonly key: string;
  readonly uploadId: string;
  readonly initiated: Date | undefined;
}

/** A part of an upload: as it went up, or as the service lists it. */
export interface S3Part {
  readonly partNumber: number;
  readonly etag: string;
  /** Base64; needed to complete an upload that was made with SHA-256 checksums. */
  readonly checksumSha256?: string | undefined;
  /** As the service lists it. */
  readonly size?: number | undefined;
}

/**
 * A request someone else makes, such as a browser: where, how, and the headers that have to go with
 * it exactly as they are here, because they are signed. Content-Length is signed too where a size
 * was given; browsers and Node send it themselves, from the body.
 */
export interface S3SignedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PresignOptions {
  /** How long the address works, in seconds: 1 to a week. */
  readonly expiresSeconds: number;
  /** For PUT: the exact size of what goes up, signed in, so that nothing else does. */
  readonly size?: number | undefined;
  /** For PUT: the SHA-256 of what goes up, base64, signed in, which the service checks. */
  readonly checksumSha256?: string | undefined;
}

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Bytes as base64, the way S3 writes checksums. */
export const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

/** A SHA-256 written in hexadecimal, as base64. */
export const hexToBase64 = (hex: string): string => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new RangeError("not hexadecimal");
  return toBase64(Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16)));
};

const digest = async (data: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data));

/** The SHA-256 of bytes or text, base64, as `x-amz-checksum-sha256` takes it. */
export const sha256Base64 = async (data: Uint8Array<ArrayBuffer> | string): Promise<string> =>
  toBase64(await digest(typeof data === "string" ? encoder.encode(data) : data));

const CHECKSUM = /^[A-Za-z0-9+/]{43}=$/;

/** 20130524T000000Z: how SigV4 writes a moment. */
const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const escapeXml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
  );

/** An element of XML as this module reads it: its name without a prefix, its text, its children. */
export interface XmlElement {
  readonly name: string;
  /** The text right in it, without that of its children, entities and CDATA read. */
  readonly text: string;
  readonly children: readonly XmlElement[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const decodeEntities = (text: string) =>
  text.replace(/&([^;&]{0,10});?/g, (whole, name: string) => {
    if (!whole.endsWith(";")) throw new SyntaxError("XML: an & that is not an entity");
    const known = ENTITIES[name];
    if (known !== undefined) return known;
    const code = /^#x[0-9a-f]{1,6}$/i.test(name)
      ? Number.parseInt(name.slice(2), 16)
      : /^#[0-9]{1,7}$/.test(name)
        ? Number(name.slice(1))
        : undefined;
    if (code === undefined || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      throw new SyntaxError("XML: an entity this does not read");
    return String.fromCodePoint(code);
  });

/**
 * Reads what S3 answers in XML: elements, text, entities and CDATA. Attributes, comments and the
 * declaration are passed over; a document type is refused, so nothing is ever expanded. Not a
 * parser of all XML, and not meant to be: only what storage services send.
 */
export const parseXml = (text: string): XmlElement => {
  type Open = { name: string; text: string; children: XmlElement[] };
  const stack: Open[] = [];
  let root: XmlElement | undefined;
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let elements = 0;
  const addText = (piece: string) => {
    const open = stack.at(-1);
    if (open) open.text += piece;
    else if (piece.trim()) throw new SyntaxError("XML: text outside of the element");
  };
  while (at < text.length) {
    const next = text.indexOf("<", at);
    if (next === -1) {
      addText(decodeEntities(text.slice(at)));
      break;
    }
    if (next > at) addText(decodeEntities(text.slice(at, next)));
    const skipTo = (end: string, from: number) => {
      const found = text.indexOf(end, from);
      if (found === -1) throw new SyntaxError("XML: cut short");
      return found + end.length;
    };
    if (text.startsWith("<?", next)) {
      at = skipTo("?>", next + 2);
    } else if (text.startsWith("<!--", next)) {
      at = skipTo("-->", next + 4);
    } else if (text.startsWith("<![CDATA[", next)) {
      const end = skipTo("]]>", next + 9);
      addText(text.slice(next + 9, end - 3));
      at = end;
    } else if (text.startsWith("<!", next)) {
      throw new SyntaxError("XML: a document type, which this does not take");
    } else if (text.startsWith("</", next)) {
      const end = skipTo(">", next + 2);
      const name = text.slice(next + 2, end - 1).trim();
      const open = stack.pop();
      if (!open || localName(name) !== open.name) throw new SyntaxError("XML: tags do not match");
      const element: XmlElement = { name: open.name, text: open.text, children: open.children };
      const parent = stack.at(-1);
      if (parent) parent.children.push(element);
      else if (root) throw new SyntaxError("XML: more than one root");
      else root = element;
      at = end;
    } else {
      // A start tag, with its attributes, which may have > in quotes.
      let end = next + 1;
      let quote: string | undefined;
      for (; end < text.length; end++) {
        const character = text[end]!;
        if (quote) {
          if (character === quote) quote = undefined;
        } else if (character === '"' || character === "'") quote = character;
        else if (character === ">") break;
      }
      if (end >= text.length) throw new SyntaxError("XML: cut short");
      const inside = text.slice(next + 1, end);
      const selfClosing = inside.endsWith("/");
      const name = /^[^\s/>]+/.exec(inside)?.[0];
      if (!name) throw new SyntaxError("XML: a tag without a name");
      if (++elements > 200_000 || stack.length >= 32)
        throw new SyntaxError("XML: larger or deeper than an answer of storage is");
      if (!stack.length && root) throw new SyntaxError("XML: more than one root");
      if (selfClosing) {
        const element: XmlElement = { name: localName(name), text: "", children: [] };
        const parent = stack.at(-1);
        if (parent) parent.children.push(element);
        else root = element;
      } else stack.push({ name: localName(name), text: "", children: [] });
      at = end + 1;
    }
  }
  if (stack.length || !root) throw new SyntaxError("XML: cut short");
  return root;
};

const localName = (name: string) => name.slice(name.lastIndexOf(":") + 1);

/** The first child of that name. */
export const xmlChild = (element: XmlElement, name: string): XmlElement | undefined =>
  element.children.find((child) => child.name === name);

/** The text of the first child of that name. */
export const xmlText = (element: XmlElement, name: string): string | undefined =>
  xmlChild(element, name)?.text;

const xmlAll = (element: XmlElement, name: string) =>
  element.children.filter((child) => child.name === name);

const dateOf = (text: string | undefined) => {
  if (text === undefined) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time);
};

const sizeOf = (text: string | undefined) => {
  const size = text === undefined ? Number.NaN : Number(text);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
};

/** The rules as XML, for PutBucketCors. */
export const corsXml = (rules: readonly S3CorsRule[]): string =>
  `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${rules
    .map(
      (rule) =>
        `<CORSRule>${[
          ...rule.allowedOrigins.map(
            (value) => `<AllowedOrigin>${escapeXml(value)}</AllowedOrigin>`,
          ),
          ...rule.allowedMethods.map(
            (value) => `<AllowedMethod>${escapeXml(value)}</AllowedMethod>`,
          ),
          ...rule.allowedHeaders.map(
            (value) => `<AllowedHeader>${escapeXml(value)}</AllowedHeader>`,
          ),
          ...rule.exposeHeaders.map((value) => `<ExposeHeader>${escapeXml(value)}</ExposeHeader>`),
          ...(rule.maxAgeSeconds === undefined
            ? []
            : [`<MaxAgeSeconds>${rule.maxAgeSeconds}</MaxAgeSeconds>`]),
        ].join("")}</CORSRule>`,
    )
    .join("")}</CORSConfiguration>`;

/**
 * The rules as the consoles of AWS and Cloudflare R2 take them, as JSON, for services whose API does
 * not let them be set: whoever runs the storage sets them there.
 */
export const corsJson = (rules: readonly S3CorsRule[]): string =>
  JSON.stringify(
    rules.map((rule) => ({
      AllowedOrigins: rule.allowedOrigins,
      AllowedMethods: rule.allowedMethods,
      AllowedHeaders: rule.allowedHeaders,
      ExposeHeaders: rule.exposeHeaders,
      ...(rule.maxAgeSeconds !== undefined && { MaxAgeSeconds: rule.maxAgeSeconds }),
    })),
    null,
    2,
  );

const readCors = (root: XmlElement): S3CorsRule[] =>
  xmlAll(root, "CORSRule").map((rule) => {
    const texts = (name: string) => xmlAll(rule, name).map((element) => element.text);
    const maxAge = sizeOf(xmlText(rule, "MaxAgeSeconds"));
    return {
      allowedOrigins: texts("AllowedOrigin"),
      allowedMethods: texts("AllowedMethod"),
      allowedHeaders: texts("AllowedHeader"),
      exposeHeaders: texts("ExposeHeader"),
      ...(maxAge !== undefined && { maxAgeSeconds: maxAge }),
    };
  });

/** Reads at most `limit` bytes of an answer, or fails. */
const readText = async (response: Response, operation: string, limit = MAX_XML_BYTES) => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new S3Error(
        operation,
        response.status,
        "TooLarge",
        `${operation}: the answer is too large`,
      );
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
};

type Body = Uint8Array<ArrayBuffer> | string;

interface Send {
  readonly key?: string | undefined;
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: Body | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * A bucket of a service, and the operations on it and on what is in it. Signing keys are kept for
 * the day, as aws4fetch does; nothing else is.
 */
export class S3Bucket {
  readonly #target: S3Target;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #keys = new Map<string, ArrayBuffer>();

  constructor(target: S3Target, options: S3Options = {}) {
    const problem = endpointProblem(target.endpoint);
    if (problem) throw new RangeError(`the endpoint ${problem}`);
    if (!isBucketName(target.bucket)) throw new RangeError("not a name of a bucket");
    if (!target.pathStyle && target.bucket.includes("."))
      throw new RangeError("a bucket with dots in its name needs path-style addresses");
    if (!REGION.test(target.region)) throw new RangeError("not a region");
    if (!target.accessKeyId || /[\s/]/.test(target.accessKeyId) || !target.secretAccessKey)
      throw new RangeError("not a key");
    this.#target = { ...target, endpoint: new URL(target.endpoint).origin };
    const fetchOf = options.fetch;
    // The global one, called as itself: a browser's fetch refuses another `this`.
    this.#fetch = fetchOf ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? S3_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
  }

  get bucket(): string {
    return this.#target.bucket;
  }

  /** Where requests go: the scheme and host of the service. */
  get endpoint(): string {
    return this.#target.endpoint;
  }

  /** The address of the bucket, or of an object in it, with a query. */
  url(key?: string, query: Readonly<Record<string, string>> = {}): URL {
    if (key !== undefined && !isSafeKey(key)) throw new RangeError("not a key this takes");
    const { endpoint, bucket, pathStyle } = this.#target;
    const base = new URL(endpoint);
    if (!pathStyle) base.hostname = `${bucket}.${base.hostname}`;
    const path = pathStyle ? `/${bucket}${key === undefined ? "" : `/${key}`}` : `/${key ?? ""}`;
    // Values as RFC 3986 has them, a name without a value as itself (`?uploads`): what SigV4 signs.
    const search = Object.entries(query)
      .map(([name, value]) =>
        value === ""
          ? encodeURIComponent(name)
          : `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
      )
      .join("&");
    return new URL(`${base.origin}${path}${search ? `?${search}` : ""}`);
  }

  /**
   * An address that lets someone else make one request, until it expires: GET or HEAD of an object,
   * or PUT of one, of exactly `size` bytes and with `checksumSha256` when given. A part of an
   * upload is `presignPart`.
   */
  async presign(
    method: "GET" | "HEAD" | "PUT",
    key: string,
    options: PresignOptions,
  ): Promise<S3SignedRequest> {
    return this.#presign(method, key, {}, options);
  }

  /** An address for one part of an upload, see `presign`: `size` is a must here. */
  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: PresignOptions & { readonly size: number },
  ): Promise<S3SignedRequest> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS)
      throw new RangeError("not a part number");
    if (!uploadId) throw new RangeError("no upload");
    return this.#presign("PUT", key, { partNumber: String(partNumber), uploadId }, options);
  }

  async #presign(
    method: string,
    key: string,
    query: Readonly<Record<string, string>>,
    { expiresSeconds, size, checksumSha256 }: PresignOptions,
  ): Promise<S3SignedRequest> {
    if (
      !Number.isInteger(expiresSeconds) ||
      expiresSeconds < 1 ||
      expiresSeconds > MAX_PRESIGN_SECONDS
    )
      throw new RangeError("not a time an address can work for");
    if (method !== "PUT" && (size !== undefined || checksumSha256 !== undefined))
      throw new RangeError("a size and a checksum are only for PUT");
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_PART_BYTES))
      throw new RangeError("not a size this signs");
    if (checksumSha256 !== undefined && !CHECKSUM.test(checksumSha256))
      throw new RangeError("not a SHA-256 in base64");
    const url = this.url(key, { ...query, "X-Amz-Expires": String(expiresSeconds) });
    const sent: Record<string, string> = {};
    if (checksumSha256 !== undefined) sent["x-amz-checksum-sha256"] = checksumSha256;
    const signer = new AwsV4Signer({
      ...this.#credentials(),
      method,
      url: url.href,
      headers: { ...sent, ...(size !== undefined && { "content-length": String(size) }) },
      signQuery: true,
      // Content-Length too, which aws4fetch leaves out unless told to sign everything given.
      allHeaders: true,
    });
    const signed = await signer.sign();
    return { method, url: signed.url.href, headers: sent };
  }

  #credentials() {
    const { accessKeyId, secretAccessKey, sessionToken, region } = this.#target;
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken !== undefined && { sessionToken }),
      service: "s3",
      region,
      cache: this.#keys,
      datetime: amzDate(this.#now()),
    };
  }

  /** Sends a request signed in its headers, with the hash of its body signed in as well. */
  async #send(operation: string, method: string, request: Send): Promise<Response> {
    request.signal?.throwIfAborted();
    const body =
      request.body === undefined
        ? undefined
        : typeof request.body === "string"
          ? encoder.encode(request.body)
          : request.body;
    const url = this.url(request.key, request.query);
    const signer = new AwsV4Signer({
      ...this.#credentials(),
      method,
      url: url.href,
      headers: {
        ...request.headers,
        "x-amz-content-sha256": toHex(await digest(body ?? EMPTY)),
      },
    });
    const signed = await signer.sign();
    const timeout = AbortSignal.timeout(request.timeoutMs ?? this.#timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(signed.url.href, {
        method,
        headers: signed.headers,
        ...(body !== undefined && { body }),
        signal,
        // A signed request is for one address: a service that sends it elsewhere is set up wrong.
        redirect: "manual",
      });
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (timeout.aborted)
        throw new S3Error(operation, 0, "Timeout", `${operation}: no answer in time`, {
          cause: error,
        });
      throw new S3Error(operation, 0, "Unreachable", `${operation}: the service did not answer`, {
        cause: error,
      });
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      throw new S3Error(
        operation,
        response.status,
        "Redirect",
        `${operation}: the service sent the request elsewhere: is the region or the address right?`,
      );
    }
    return response;
  }

  /** What the service said was wrong, from its XML when there is any. */
  async #failure(operation: string, response: Response): Promise<S3Error> {
    const text = await readText(response, operation).catch(() => "");
    let code: string | undefined;
    let message: string | undefined;
    try {
      const root = parseXml(text);
      if (root.name === "Error") {
        code = xmlText(root, "Code");
        message = xmlText(root, "Message");
      }
    } catch {}
    return new S3Error(
      operation,
      response.status,
      code || `HTTP ${response.status}`,
      `${operation}: ${code || `HTTP ${response.status}`}${message ? `: ${message}` : ""}`,
    );
  }

  /** An answer of XML, read; an `<Error>` in it, as a 200 of CompleteMultipartUpload can be, fails. */
  async #xml(operation: string, response: Response): Promise<XmlElement> {
    if (!response.ok) throw await this.#failure(operation, response);
    const text = await readText(response, operation);
    let root: XmlElement;
    try {
      root = parseXml(text);
    } catch (error) {
      throw new S3Error(operation, response.status, "BadAnswer", `${operation}: ${String(error)}`);
    }
    if (root.name === "Error") {
      const code = xmlText(root, "Code") || "Error";
      throw new S3Error(
        operation,
        response.status,
        code,
        `${operation}: ${code}: ${xmlText(root, "Message") ?? ""}`,
      );
    }
    return root;
  }

  async #done(operation: string, response: Response) {
    if (!response.ok) throw await this.#failure(operation, response);
    await response.body?.cancel().catch(() => {});
  }

  /**
   * Whether the bucket is there: true, or false when there is no such bucket. Any other answer, such
   * as a key that is not right (403), fails.
   */
  async headBucket(): Promise<boolean> {
    const response = await this.#send("headBucket", "HEAD", {});
    if (response.status === 404) return false;
    await this.#done("headBucket", response);
    return true;
  }

  /** Makes the bucket, private, unless the same key has it already. */
  async createBucket(): Promise<"created" | "existed"> {
    const { region } = this.#target;
    const body =
      region === "us-east-1"
        ? undefined
        : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`;
    const response = await this.#send("createBucket", "PUT", {
      ...(body !== undefined && { body, headers: { "content-type": "application/xml" } }),
    });
    if (response.status === 409) {
      const failure = await this.#failure("createBucket", response);
      if (failure.code === "BucketAlreadyOwnedByYou") return "existed";
      throw failure;
    }
    await this.#done("createBucket", response);
    return "created";
  }

  /** The bucket's rules for other sites, or undefined when it has none. */
  async getCors(): Promise<S3CorsRule[] | undefined> {
    const response = await this.#send("getCors", "GET", { query: { cors: "" } });
    if (response.status === 404) {
      const failure = await this.#failure("getCors", response);
      if (failure.code === "NoSuchCORSConfiguration") return undefined;
      throw failure;
    }
    return readCors(await this.#xml("getCors", response));
  }

  /**
   * Replaces the bucket's rules for other sites. With a SHA-256 of them rather than Content-MD5,
   * which S3 takes for both and browsers cannot make.
   */
  async putCors(rules: readonly S3CorsRule[]): Promise<void> {
    const body = corsXml(rules);
    const response = await this.#send("putCors", "PUT", {
      query: { cors: "" },
      headers: {
        "content-type": "application/xml",
        "x-amz-checksum-sha256": await sha256Base64(body),
      },
      body,
    });
    await this.#done("putCors", response);
  }

  /** An object, or undefined when there is none. */
  async headObject(key: string): Promise<S3ObjectInfo | undefined> {
    const response = await this.#send("headObject", "HEAD", {
      key,
      headers: { "x-amz-checksum-mode": "ENABLED" },
    });
    if (response.status === 404) return undefined;
    await this.#done("headObject", response);
    const size = sizeOf(response.headers.get("content-length") ?? undefined);
    if (size === undefined)
      throw new S3Error("headObject", response.status, "BadAnswer", "headObject: no size");
    return {
      size,
      etag: response.headers.get("etag") ?? "",
      contentType: response.headers.get("content-type") ?? undefined,
      lastModified: dateOf(response.headers.get("last-modified") ?? undefined),
      checksumSha256: response.headers.get("x-amz-checksum-sha256") ?? undefined,
    };
  }

  /** Stores a small object in one request, with its SHA-256, which the service checks. */
  async putObject(
    key: string,
    content: Body,
    { contentType = "application/octet-stream" }: { readonly contentType?: string } = {},
  ): Promise<{ readonly etag: string }> {
    const body = typeof content === "string" ? encoder.encode(content) : content;
    if (body.byteLength > MAX_PART_BYTES) throw new RangeError("too large for one request");
    const response = await this.#send("putObject", "PUT", {
      key,
      headers: { "content-type": contentType, "x-amz-checksum-sha256": await sha256Base64(body) },
      body,
    });
    await this.#done("putObject", response);
    return { etag: response.headers.get("etag") ?? "" };
  }

  /**
   * An object's content, as the answer to read it from: `ok`, with a body. No such object fails
   * with 404 and NoSuchKey.
   */
  async getObject(
    key: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<Response> {
    const response = await this.#send("getObject", "GET", { key, ...options });
    if (!response.ok) throw await this.#failure("getObject", response);
    return response;
  }

  /** Removes an object; one that is not there is no failure. */
  async deleteObject(key: string): Promise<void> {
    const response = await this.#send("deleteObject", "DELETE", { key });
    if (response.status !== 404) return this.#done("deleteObject", response);
    await response.body?.cancel().catch(() => {});
  }

  /** A page of the objects whose keys start with `prefix`, and where the next one starts. */
  async listObjects({
    prefix,
    next,
    maxKeys = 1000,
  }: {
    readonly prefix: string;
    readonly next?: string | undefined;
    readonly maxKeys?: number;
  }): Promise<{ readonly objects: S3ListedObject[]; readonly next: string | undefined }> {
    const root = await this.#xml(
      "listObjects",
      await this.#send("listObjects", "GET", {
        query: {
          "list-type": "2",
          prefix,
          "max-keys": String(maxKeys),
          ...(next !== undefined && { "continuation-token": next }),
        },
      }),
    );
    const objects = xmlAll(root, "Contents").map((element) => ({
      key: xmlText(element, "Key") ?? "",
      size: sizeOf(xmlText(element, "Size")) ?? 0,
      etag: xmlText(element, "ETag") ?? "",
      lastModified: dateOf(xmlText(element, "LastModified")),
    }));
    const truncated = xmlText(root, "IsTruncated") === "true";
    const token = xmlText(root, "NextContinuationToken");
    if (truncated && !token)
      throw new S3Error("listObjects", 200, "BadAnswer", "listObjects: more, but not where");
    return { objects, next: truncated ? token : undefined };
  }

  /** Uploads in parts that were started and neither completed nor aborted, for keys with `prefix`. */
  async listUploads({ prefix }: { readonly prefix: string }): Promise<S3Upload[]> {
    const uploads: S3Upload[] = [];
    let marker: { key: string; uploadId: string } | undefined;
    for (let page = 0; page < 1000; page++) {
      const root = await this.#xml(
        "listUploads",
        await this.#send("listUploads", "GET", {
          query: {
            uploads: "",
            prefix,
            ...(marker && { "key-marker": marker.key, "upload-id-marker": marker.uploadId }),
          },
        }),
      );
      for (const element of xmlAll(root, "Upload"))
        uploads.push({
          key: xmlText(element, "Key") ?? "",
          uploadId: xmlText(element, "UploadId") ?? "",
          initiated: dateOf(xmlText(element, "Initiated")),
        });
      if (xmlText(root, "IsTruncated") !== "true") return uploads;
      const key = xmlText(root, "NextKeyMarker");
      const uploadId = xmlText(root, "NextUploadIdMarker");
      if (!key || (marker && key === marker.key && uploadId === marker.uploadId))
        throw new S3Error("listUploads", 200, "BadAnswer", "listUploads: more, but not where");
      marker = { key, uploadId: uploadId ?? "" };
    }
    throw new S3Error("listUploads", 200, "BadAnswer", "listUploads: too many pages");
  }

  /**
   * Starts an upload in parts, whose object gets `contentType`. With `checksum: "sha256"`, every
   * part has to come with its SHA-256, which the service checks, see `presignPart`.
   */
  async createUpload(
    key: string,
    {
      contentType = "application/octet-stream",
      checksum,
    }: { readonly contentType?: string; readonly checksum: "sha256" | "none" },
  ): Promise<string> {
    const root = await this.#xml(
      "createUpload",
      await this.#send("createUpload", "POST", {
        key,
        query: { uploads: "" },
        headers: {
          "content-type": contentType,
          ...(checksum === "sha256" && { "x-amz-checksum-algorithm": "SHA256" }),
        },
      }),
    );
    const uploadId = xmlText(root, "UploadId");
    if (!uploadId)
      throw new S3Error("createUpload", 200, "BadAnswer", "createUpload: no upload id");
    return uploadId;
  }

  /** The parts of an upload that the service has, in order, all pages of them. */
  async listParts(key: string, uploadId: string): Promise<S3Part[]> {
    const parts: S3Part[] = [];
    let marker = 0;
    for (;;) {
      const root = await this.#xml(
        "listParts",
        await this.#send("listParts", "GET", {
          key,
          query: { uploadId, ...(marker > 0 && { "part-number-marker": String(marker) }) },
        }),
      );
      for (const element of xmlAll(root, "Part")) {
        const partNumber = sizeOf(xmlText(element, "PartNumber"));
        if (partNumber === undefined || partNumber < 1 || partNumber > MAX_PARTS)
          throw new S3Error("listParts", 200, "BadAnswer", "listParts: not a part number");
        parts.push({
          partNumber,
          etag: xmlText(element, "ETag") ?? "",
          size: sizeOf(xmlText(element, "Size")),
          checksumSha256: xmlText(element, "ChecksumSHA256") || undefined,
        });
      }
      if (xmlText(root, "IsTruncated") !== "true") return parts;
      const next = sizeOf(xmlText(root, "NextPartNumberMarker"));
      // Each page has to go further, or this would never end.
      if (next === undefined || next <= marker || next >= MAX_PARTS)
        throw new S3Error("listParts", 200, "BadAnswer", "listParts: more, but not where");
      marker = next;
    }
  }

  /**
   * Makes the parts one object. They go in the order of their numbers, each once, with their SHA-256
   * where the upload was started with one. Slow for large objects on some services (see
   * `COMPLETE_TIMEOUT_MS`).
   */
  async completeUpload(
    key: string,
    uploadId: string,
    parts: readonly S3Part[],
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly etag: string; readonly checksumSha256: string | undefined }> {
    if (parts.length === 0 || parts.length > MAX_PARTS)
      throw new RangeError("not a number of parts");
    const sorted = parts.toSorted((a, b) => a.partNumber - b.partNumber);
    sorted.forEach((part, index) => {
      if (index > 0 && part.partNumber === sorted[index - 1]!.partNumber)
        throw new RangeError("a part twice");
      if (!part.etag) throw new RangeError("a part without its ETag");
      if (part.checksumSha256 !== undefined && !CHECKSUM.test(part.checksumSha256))
        throw new RangeError("not a SHA-256 in base64");
    });
    const body = `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${sorted
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag>${
            part.checksumSha256 === undefined
              ? ""
              : `<ChecksumSHA256>${part.checksumSha256}</ChecksumSHA256>`
          }</Part>`,
      )
      .join("")}</CompleteMultipartUpload>`;
    const root = await this.#xml(
      "completeUpload",
      await this.#send("completeUpload", "POST", {
        key,
        query: { uploadId },
        headers: { "content-type": "application/xml" },
        body,
        timeoutMs: options.timeoutMs ?? COMPLETE_TIMEOUT_MS,
        signal: options.signal,
      }),
    );
    return {
      etag: xmlText(root, "ETag") ?? "",
      checksumSha256: xmlText(root, "ChecksumSHA256") || undefined,
    };
  }

  /** Gives an upload up, and the parts with it. One that is not there any more is no failure. */
  async abortUpload(key: string, uploadId: string): Promise<void> {
    const response = await this.#send("abortUpload", "DELETE", { key, query: { uploadId } });
    if (response.status === 404) {
      const failure = await this.#failure("abortUpload", response);
      if (failure.code === "NoSuchUpload") return;
      throw failure;
    }
    await this.#done("abortUpload", response);
  }
}
