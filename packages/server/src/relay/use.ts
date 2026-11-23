/**
 * What the relay tells whoever runs the server of each request it passed on (relay/routes.ts): who,
 * when, and how many bytes each way, never what was in them or where they went. Nothing counts them
 * unless the server is given a `RelayUsage`.
 */
export interface RelayUse {
  readonly userId: string;
  /** When the request started. */
  readonly at: Date;
  /** Bytes of the request that went to the service. */
  readonly sent: number;
  /** Bytes of the answer that came back. */
  readonly received: number;
}

export interface RelayUsage {
  record(use: RelayUse): Promise<void>;
}
