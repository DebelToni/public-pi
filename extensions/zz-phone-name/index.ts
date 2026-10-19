import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { streamSimple, type Api, type Model, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { randomUUID } from "node:crypto";
import { buildCacheForkPayload, cloneValue, isRecord, promptCacheKey, type JsonRecord } from "../zz-btw/cache.ts";

export const STATE_TYPE = "phone-session-name";
export const NAME_PROMPT = "Generate a concise session name for the conversation above. Output ONLY Phone- followed by a descriptive lowercase ASCII kebab-case topic. Use at most seven topic words (eight words total including Phone). No quotes, explanation, punctuation other than hyphens, or tools. This is a hidden naming request; do not continue the task.";

type Capsule = {
  sessionId: string;
  model: Model<Api>;
  payload: JsonRecord;
  messages: ReturnType<typeof convertToLlm>;
  auth: { apiKey: string; headers: Record<string, string | null>; env?: Record<string, string> };
  capturedAt: number;
};

export function normalizePhoneName(text: string) {
  const value = text.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (/\r|\n/.test(value) || !/^Phone-/i.test(value)) throw new Error("The naming response was not a session name.");
  const words = value.slice(6).toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).slice(0, 7);
  if (!words.length) throw new Error("The naming response had no topic.");
  return `Phone-${words.join("-")}`;
}

export default function phoneNaming(pi: ExtensionAPI, runStream = streamSimple) {
  let context: ExtensionContext | undefined;
  let enabled = false, attempted = false, epoch = 0;
  let messages: Capsule["messages"] = [];
  let auth: Capsule["auth"] | undefined;
  let capsule: Capsule | undefined;
  let controller: AbortController | undefined;

  const cancel = () => { epoch++; controller?.abort(); controller = undefined; capsule = undefined; auth = undefined; messages = []; };
  const eligible = () => enabled && !attempted && pi.getSessionName() === "Phone";
  pi.on("session_start", (event, ctx) => {
    cancel(); context = ctx;
    // Naming is session-wide, not branch-sensitive. Abandoned branches must not trigger a second request.
    const entries = ctx.sessionManager.getEntries();
    const states = entries.filter((entry: any) => entry.type === "custom" && entry.customType === STATE_TYPE);
    enabled = states.some((entry: any) => entry.data?.status === "origin");
    attempted = states.some((entry: any) => entry.data?.status !== "origin");
    if (!enabled && event.reason === "startup" && ctx.mode === "tui" && process.env.PI_PHONE_CHAT === "1" && pi.getSessionName() === "Phone" && !entries.some((entry: any) => entry.type === "message" && entry.message?.role === "assistant")) {
      pi.appendEntry(STATE_TYPE, {status:"origin"}); enabled = true;
    }
  });
  pi.on("session_shutdown", () => { cancel(); context = undefined; enabled = false; });
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_info_changed", () => { if (pi.getSessionName() !== "Phone") cancel(); });
  pi.on("context_with_system", (event) => {
    if (eligible()) messages = cloneValue(convertToLlm(event.messages));
  });
  pi.on("before_provider_headers", async (event, ctx) => {
    auth = undefined; capsule = undefined;
    if (!eligible() || ctx.model?.api !== "openai-codex-responses") return;
    const generation = epoch, model = ctx.model;
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (generation !== epoch || !eligible() || !resolved.ok || !resolved.apiKey) return;
    // Keep the live header reference until all header hooks have finished.
    auth = {apiKey:resolved.apiKey, headers:event.headers, env:resolved.env};
  });
  pi.on("before_provider_request", (event, ctx) => {
    capsule = undefined;
    if (!eligible() || ctx.model?.api !== "openai-codex-responses" || !auth || !messages.length || !isRecord(event.payload) || !Array.isArray(event.payload.input) || !promptCacheKey(event.payload)) return;
    capsule = {sessionId:ctx.sessionManager.getSessionId(), model:cloneValue(ctx.model), payload:cloneValue(event.payload), messages:cloneValue(messages), auth:cloneValue(auth), capturedAt:Date.now()};
  });

  async function nameSession(parent: Capsule, response: AssistantMessage, ctx: ExtensionContext) {
    const generation = epoch;
    const active = () => generation === epoch && context?.sessionManager.getSessionId() === parent.sessionId && pi.getSessionName() === "Phone";
    const requestController = new AbortController(); controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 60_000);
    const sideId = randomUUID();
    let usage: AssistantMessage["usage"] | undefined;
    let verified = false;
    try {
      if (Date.now() - parent.capturedAt >= 5 * 60_000) throw new Error("The parent prompt cache is too old.");
      const stream = runStream(parent.model, {
        messages:[...parent.messages, cloneValue(response), {role:"user", content:[{type:"text", text:NAME_PROMPT}], timestamp:Date.now()}],
      }, {
        ...parent.auth,
        signal:requestController.signal, transport:"sse", sessionId:sideId, cacheRetention:"short", toolChoice:"none",
        timeoutMs:60_000, maxRetries:0,
        fetch: ((input: any, init: any) => {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          headers.set("session-id", parent.sessionId); headers.set("thread-id", sideId); headers.set("x-client-request-id", sideId);
          return globalThis.fetch(input, {...init, headers});
        }) as typeof fetch,
        onPayload(candidate) {
          if (!active() || requestController.signal.aborted) throw new Error("Naming cancelled.");
          const fork = buildCacheForkPayload(parent.payload, candidate, NAME_PROMPT);
          verified = true;
          return fork.payload;
        },
      });
      for await (const event of stream) {
        if (event.type.startsWith("toolcall_")) { requestController.abort(); throw new Error("Naming attempted a tool call; no tool was executed."); }
      }
      const result = await stream.result(); usage = result.usage;
      if (!active()) return;
      if (requestController.signal.aborted) throw new Error("Naming timed out after 60 seconds.");
      if (!verified || result.stopReason !== "stop" || result.content.some(part => part.type === "toolCall")) throw new Error(result.errorMessage || "Naming did not complete safely.");
      const name = normalizePhoneName(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
      pi.appendEntry(STATE_TYPE, {status:"named", name, provider:parent.model.provider, model:parent.model.id, usage, exactPrefix:true, parentPromptTokens:response.usage.input + response.usage.cacheRead + response.usage.cacheWrite});
      pi.setSessionName(name);
    } catch (error) {
      if (!active() || requestController.signal.aborted && generation !== epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      pi.appendEntry(STATE_TYPE, {status:"failed", error:message, usage});
      ctx.ui.notify(`Phone auto-name failed: ${message}`, "warning");
    } finally {
      clearTimeout(timeout);
      if (controller === requestController) controller = undefined;
    }
  }

  pi.on("message_end", (event, ctx) => {
    const response = event.message;
    if (!eligible() || response.role !== "assistant" || response.stopReason !== "stop" || !response.content.some(part => part.type === "text" && part.text.trim()) || response.content.some(part => part.type === "toolCall")) return;
    attempted = true;
    pi.appendEntry(STATE_TYPE, {status:"attempted"});
    const parent = capsule;
    if (!parent || parent.sessionId !== ctx.sessionManager.getSessionId() || response.provider !== parent.model.provider || response.model !== parent.model.id) {
      pi.appendEntry(STATE_TYPE, {status:"skipped", error:"Exact cached Codex request unavailable."});
      ctx.ui.notify("Phone auto-name skipped: exact cached Codex request unavailable. No fallback model was used.", "warning");
      return;
    }
    void nameSession(parent, cloneValue(response), ctx);
  });
}
