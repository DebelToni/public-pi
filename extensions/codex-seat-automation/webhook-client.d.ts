export type SeatJob = {
  kind: "seat.rotate";
  operationId: string;
  state: "accepted" | "running" | "succeeded" | "failed" | "uncertain";
  result: null | { ok: boolean; code: string; message: string; data: Record<string, unknown> };
  isTerminal: boolean;
};

export type VerifiedWebhookResult = {
  status: number;
  ok: boolean;
  code: string;
  message: string;
  retryAfterSeconds?: number;
  job: SeatJob | null;
  payload: Record<string, unknown>;
};

export type WebhookOptions = {
  privateKeyPath: string;
  operationId: string;
  keyId: string;
  macPublicKeyPath: string;
  url: string;
  audience?: string;
  timeoutMs?: number;
};

export function newOperationId(): string;
export function rotateSeat(options: WebhookOptions): Promise<VerifiedWebhookResult>;
export function seatStatus(options: WebhookOptions): Promise<VerifiedWebhookResult>;
