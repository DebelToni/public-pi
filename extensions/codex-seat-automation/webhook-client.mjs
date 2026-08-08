#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { parse as parseStrictJSON } from "lossless-json";
import sshpk from "sshpk";

export const DEFAULT_URL = "https://invalid.example/hook/configure-in-local-settings";
export const DEFAULT_KEY_ID = "friend-1";
const PROTOCOL = "mac-webhook-v1";
const CONTENT_TYPE = "application/json";
const SERVER_KEY_ID = "mac-1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 4096;
const MAX_RESPONSE_BODY_BYTES = 16_384;
const JOB_STATES = new Set(["accepted", "running", "succeeded", "failed", "uncertain"]);
const ACTIVE_JOB_STATES = new Set(["accepted", "running"]);
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "uncertain"]);
const ERROR_CODE_STATUS = new Map([
  ["INVALID_JSON", 400],
  ["INVALID_REQUEST", 400],
  ["JOB_NOT_FOUND", 404],
  ["ACTION_IN_PROGRESS", 409],
  ["REPLAYED_REQUEST", 409],
  ["ACTION_SUCCESS_COOLDOWN", 429],
  ["ACTION_FAILURE_COOLDOWN", 429],
  ["ACTION_BLOCKED_UNCERTAIN", 503],
  ["STATE_UNAVAILABLE", 503],
]);

function b64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function b64urlDecode(value, expectedBytes) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url value");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || b64urlEncode(decoded) !== value) {
    throw new Error("invalid base64url length or encoding");
  }
  return decoded;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function requestBase(keyId, audience, timestamp, nonce, body) {
  return Buffer.from(
    [
      PROTOCOL,
      "type=request",
      `key-id=${keyId}`,
      `audience=${audience}`,
      "method=POST",
      `timestamp=${timestamp}`,
      `nonce=${nonce}`,
      `content-type=${CONTENT_TYPE}`,
      `body-length=${body.length}`,
      `body-sha256=${sha256Hex(body)}`,
      "",
    ].join("\n"),
    "ascii",
  );
}

function responseBase(audience, requestHash, requestNonce, timestamp, status, body) {
  return Buffer.from(
    [
      PROTOCOL,
      "type=response",
      `key-id=${SERVER_KEY_ID}`,
      `audience=${audience}`,
      `request-hash=${requestHash}`,
      `request-nonce=${requestNonce}`,
      `timestamp=${timestamp}`,
      `status=${String(status).padStart(3, "0")}`,
      `content-type=${CONTENT_TYPE}`,
      `body-length=${body.length}`,
      `body-sha256=${sha256Hex(body)}`,
      "",
    ].join("\n"),
    "ascii",
  );
}

function loadPrivateKey(filename) {
  const options = process.env.WEBHOOK_KEY_PASSPHRASE
    ? { passphrase: process.env.WEBHOOK_KEY_PASSPHRASE }
    : undefined;
  const key = sshpk.parsePrivateKey(fs.readFileSync(filename), "auto", options);
  if (key.type !== "ed25519") {
    throw new Error("the sender key must be an OpenSSH Ed25519 private key");
  }
  return key;
}

function loadPublicKey(filename) {
  const key = sshpk.parseKey(fs.readFileSync(filename), "auto");
  if (key.type !== "ed25519") {
    throw new Error("the Mac key must be an OpenSSH Ed25519 public key");
  }
  return key;
}

function canonicalOperationId(operationId) {
  if (typeof operationId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) {
    throw new Error("operationId must be a canonical UUID");
  }
  return operationId;
}

export function newOperationId() {
  return crypto.randomUUID();
}

export function requestBody(kind, operationId) {
  if (kind !== "seat.rotate" && kind !== "seat.status") {
    throw new Error("kind must be seat.rotate or seat.status");
  }
  canonicalOperationId(operationId);
  const body = Buffer.from(JSON.stringify({ kind, operation_id: operationId }), "utf8");
  if (body.length > MAX_BODY_BYTES) {
    throw new Error("request body exceeds the 4096-byte limit");
  }
  return body;
}

function rejectPrototypeKeys(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Object.hasOwn(value, "__proto__")) {
    throw new Error("signed response contains reserved __proto__ key");
  }
  for (const nested of Object.values(value)) {
    rejectPrototypeKeys(nested);
  }
}

function parseResponseObject(responseBody) {
  if (responseBody.length > MAX_RESPONSE_BODY_BYTES) {
    throw new Error("signed response body is too large");
  }
  const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBody);
  const nativePayload = JSON.parse(responseText);
  rejectPrototypeKeys(nativePayload);
  const payload = parseStrictJSON(responseText, undefined, {
    parseNumber: (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new Error("signed response contains a non-finite number");
      }
      if (/^-?\d+$/.test(value) && !Number.isSafeInteger(number)) {
        throw new Error("signed response contains an unsafe integer");
      }
      return number;
    },
  });
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("signed response payload is not an object");
  }
  return payload;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validatedJob(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
      || !hasExactKeys(payload, ["kind", "operation_id", "state", "result"])) {
    throw new Error("signed response has an invalid job object");
  }
  if (payload.kind !== "seat.rotate") {
    throw new Error("signed response job kind is invalid");
  }
  canonicalOperationId(payload.operation_id);
  if (typeof payload.state !== "string" || !JOB_STATES.has(payload.state)) {
    throw new Error("signed response job state is invalid");
  }

  let result = null;
  if (ACTIVE_JOB_STATES.has(payload.state)) {
    if (payload.result !== null) {
      throw new Error("active signed job contains a terminal result");
    }
  } else {
    const rawResult = payload.result;
    if (rawResult === null || typeof rawResult !== "object" || Array.isArray(rawResult)
        || !hasExactKeys(rawResult, ["ok", "code", "message", "data"])) {
      throw new Error("terminal signed job has an invalid result");
    }
    if (typeof rawResult.ok !== "boolean") {
      throw new Error("signed job result has an invalid ok field");
    }
    if (typeof rawResult.code !== "string"
        || !/^[A-Z][A-Z0-9_]{0,63}$/.test(rawResult.code)) {
      throw new Error("signed job result has an invalid code field");
    }
    if (typeof rawResult.message !== "string" || rawResult.message.length === 0) {
      throw new Error("signed job result has an invalid message field");
    }
    if (rawResult.data === null || typeof rawResult.data !== "object"
        || Array.isArray(rawResult.data)) {
      throw new Error("signed job result has an invalid data field");
    }
    if ((payload.state === "succeeded") !== rawResult.ok) {
      throw new Error("signed job state and result disagree");
    }
    result = {
      ok: rawResult.ok,
      code: rawResult.code,
      message: rawResult.message,
      data: rawResult.data,
    };
  }
  return {
    kind: "seat.rotate",
    operationId: payload.operation_id,
    state: payload.state,
    result,
    isTerminal: TERMINAL_JOB_STATES.has(payload.state),
  };
}

export function validatedResult(status, responseBody, retryAfterHeader) {
  const payload = parseResponseObject(responseBody);
  if (!Object.hasOwn(payload, "ok")
      || !Object.hasOwn(payload, "code")
      || !Object.hasOwn(payload, "message")) {
    throw new Error("signed response is missing required fields");
  }
  if (typeof payload.ok !== "boolean") {
    throw new Error("signed response has invalid ok field");
  }
  if (typeof payload.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(payload.code)) {
    throw new Error("signed response has invalid code field");
  }
  if (typeof payload.message !== "string" || payload.message.length === 0) {
    throw new Error("signed response has invalid message field");
  }
  if ((status >= 200 && status < 300) !== payload.ok) {
    throw new Error("signed response status and ok field disagree");
  }

  let job = null;
  let retryAfterSeconds;
  if (payload.code === "JOB_ACCEPTED") {
    if (status !== 202 || !hasExactKeys(payload, ["ok", "code", "message", "job"])) {
      throw new Error("signed JOB_ACCEPTED response has an invalid contract");
    }
    job = validatedJob(payload.job);
    if (!ACTIVE_JOB_STATES.has(job.state)) {
      throw new Error("signed JOB_ACCEPTED response is terminal");
    }
  } else if (payload.code === "JOB_STATUS") {
    if (status !== 200 || !hasExactKeys(payload, ["ok", "code", "message", "job"])) {
      throw new Error("signed JOB_STATUS response has an invalid contract");
    }
    job = validatedJob(payload.job);
  } else {
    const expectedStatus = ERROR_CODE_STATUS.get(payload.code);
    if (expectedStatus === undefined || status !== expectedStatus) {
      throw new Error("signed response code and HTTP status disagree");
    }
    if (status === 429) {
      if (!hasExactKeys(payload, ["ok", "code", "message", "retry_after_seconds"])) {
        throw new Error("signed cooldown response has an invalid contract");
      }
      retryAfterSeconds = payload.retry_after_seconds;
      if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds <= 0) {
        throw new Error("signed response has invalid retry_after_seconds");
      }
    } else if (!hasExactKeys(payload, ["ok", "code", "message"])) {
      throw new Error("signed error response has an invalid contract");
    }
  }

  if (retryAfterSeconds === undefined) {
    if (retryAfterHeader !== null) {
      throw new Error("unsigned Retry-After header has no signed value");
    }
  } else if (retryAfterHeader !== String(retryAfterSeconds)) {
    throw new Error("Retry-After header does not match the signed response");
  }

  return {
    status,
    ok: payload.ok,
    code: payload.code,
    message: payload.message,
    retryAfterSeconds,
    job,
    payload,
  };
}

export async function readLimitedResponseBody(response) {
  const contentLength = response.headers.get("content-length");
  if (/^[0-9]+$/.test(contentLength || "")
      && Number(contentLength) > MAX_RESPONSE_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error("unverified response body exceeds the 16384-byte limit");
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        throw new Error("unverified response body exceeds the 16384-byte limit");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The original read/limit error is authoritative.
    }
    throw error;
  }
  return Buffer.concat(chunks, total);
}

export async function sendWebhook({
  privateKeyPath,
  kind,
  operationId,
  keyId = DEFAULT_KEY_ID,
  macPublicKeyPath = path.join(HERE, "mac-webhook.pub"),
  url = DEFAULT_URL,
  audience = url,
  timeoutMs = 15_000,
}) {
  if (!privateKeyPath) {
    throw new Error("privateKeyPath is required");
  }
  if (typeof keyId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error("keyId is invalid");
  }
  const body = requestBody(kind, operationId);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = b64urlEncode(crypto.randomBytes(32));
  const signatureBase = requestBase(keyId, audience, timestamp, nonce, body);
  const signer = loadPrivateKey(privateKeyPath).createSign();
  signer.update(signatureBase);
  const signature = b64urlEncode(signer.sign().toBuffer("raw"));

  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": CONTENT_TYPE,
      "X-Webhook-Key-Id": keyId,
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Nonce": nonce,
      "X-Webhook-Signature": signature,
    },
    body,
  });
  const responseBody = await readLimitedResponseBody(response);
  const responseTimestamp = response.headers.get("x-webhook-timestamp") || "";
  const responseNonce = response.headers.get("x-webhook-request-nonce") || "";
  const responseRequestHash = response.headers.get("x-webhook-request-hash") || "";
  const responseSignature = response.headers.get("x-webhook-signature") || "";
  const expectedRequestHash = sha256Hex(signatureBase);

  if (response.headers.get("content-type") !== CONTENT_TYPE) {
    throw new Error(`unsigned or invalid response: HTTP ${response.status}`);
  }
  if (response.headers.get("x-webhook-key-id") !== SERVER_KEY_ID) {
    throw new Error("response key ID is invalid");
  }
  if (responseNonce !== nonce || responseRequestHash !== expectedRequestHash) {
    throw new Error("response is not bound to this request");
  }
  if (!/^[1-9][0-9]{0,10}$/.test(responseTimestamp)
      || Math.abs(Math.floor(Date.now() / 1000) - Number(responseTimestamp)) > 300) {
    throw new Error("response timestamp is invalid");
  }

  const signedResponse = responseBase(
    audience,
    expectedRequestHash,
    nonce,
    responseTimestamp,
    response.status,
    responseBody,
  );
  const parsedSignature = sshpk.Signature.parse(
    b64urlDecode(responseSignature, 64),
    "ed25519",
    "raw",
  );
  const verifier = loadPublicKey(macPublicKeyPath).createVerify();
  verifier.update(signedResponse);
  if (!verifier.verify(parsedSignature)) {
    throw new Error("Mac response signature is invalid");
  }

  const result = validatedResult(
    response.status,
    responseBody,
    response.headers.get("retry-after"),
  );
  if (result.job !== null && result.job.operationId !== operationId) {
    throw new Error("signed response contains the wrong operation ID");
  }
  return result;
}

export function rotateSeat(options) {
  return sendWebhook({ ...options, kind: "seat.rotate" });
}

export function seatStatus(options) {
  return sendWebhook({ ...options, kind: "seat.status" });
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function pollSeatStatus({
  timeoutMs = 300_000,
  pollIntervalMs = 1_000,
  statusSender = seatStatus,
  sleep = defaultSleep,
  now = Date.now,
  ...options
}) {
  if (!(timeoutMs > 0) || !(pollIntervalMs > 0)) {
    throw new Error("poll timeout and interval must be positive");
  }
  const deadline = now() + timeoutMs;
  while (true) {
    const result = await statusSender(options);
    if (result.job === null || result.job.isTerminal) {
      return result;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error("seat operation did not reach a terminal state");
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

async function main() {
  const privateKeyPath = process.argv[2] || process.env.WEBHOOK_PRIVATE_KEY;
  const command = process.argv[3];
  const operationId = process.argv[4];
  const shouldPoll = process.argv.includes("--poll");
  if (!privateKeyPath || !["rotate", "status"].includes(command) || !operationId) {
    throw new Error(
      "usage: node node_sender.mjs /path/to/private-key rotate|status OPERATION_UUID [--poll]",
    );
  }
  const common = {
    privateKeyPath,
    operationId,
    keyId: process.env.WEBHOOK_KEY_ID || DEFAULT_KEY_ID,
    macPublicKeyPath: process.env.MAC_WEBHOOK_PUBLIC_KEY || path.join(HERE, "mac-webhook.pub"),
    url: process.env.WEBHOOK_URL || DEFAULT_URL,
    audience: process.env.WEBHOOK_AUDIENCE || process.env.WEBHOOK_URL || DEFAULT_URL,
  };
  let result = command === "rotate"
    ? await rotateSeat(common)
    : await seatStatus(common);
  if (command === "rotate" && shouldPoll && result.ok) {
    result = await pollSeatStatus(common);
  }
  console.log(`Verified HTTP ${result.status} ${result.code} from the Mac`);
  console.log(JSON.stringify(result.payload, null, 2));
  if (!result.ok || (result.job?.isTerminal && !result.job.result?.ok)) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  });
}
