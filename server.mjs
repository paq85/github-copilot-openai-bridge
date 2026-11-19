import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";

const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.BRIDGE_API_KEY; // optional bearer token
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "auto";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 60 * 60 * 1000);
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 600_000);
const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const CONTEXT_TIERS = ["default", "long_context"];
const BUSY_WAIT_MS = Number(process.env.BUSY_WAIT_MS ?? 30_000);
const EMIT_REASONING = !/^(0|false|no|off)$/i.test(process.env.EMIT_REASONING ?? "");
const TOOL_BATCH_MS = 250; // window to collect parallel tool calls from one assistant message
// `auto`/Fusion route per request to models whose runtime budget is lower than the catalog
// says (claude-* ran with a 200k window under auto). Advertise the smallest real budget so
// clients compact in time; override when Copilot changes it.
const AUTO_CONTEXT_WINDOW = Number(process.env.AUTO_CONTEXT_WINDOW ?? 200_000);
// SSE headers are held back this long so early failures (e.g. prompt too long) still get a
// real HTTP status that clients can classify, instead of a broken 200 stream.
const STREAM_HEADER_DELAY_MS = Number(process.env.STREAM_HEADER_DELAY_MS ?? 8_000);
// Exit after this long without any HTTP request (0 = never). The Hermes plugin sets it so a
// bridge shared by several Hermes processes outlives whichever process started it.
const IDLE_EXIT_MS = Number(process.env.IDLE_EXIT_MS ?? 0);

// ---------- logging ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint(2), red = paint(31), green = paint(32), yellow = paint(33), cyan = paint(36), bold = paint(1);
const log = (...a) => console.log(dim(new Date().toISOString().slice(11, 23)), ...a);
const n = (x) => Math.round(x ?? 0).toLocaleString("en-US");
const aiu = (x) => (x ?? 0).toFixed(4);
const short = (id) => id.slice(0, 8);

const client = new CopilotClient();
// Started after the port is bound (see bottom), so a second instance racing for the same port
// exits immediately instead of spawning a Copilot runtime first.
let clientReady;

// ---------- message normalisation / session matching ----------
const text = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("") : "";

const isSys = (m) => m.role === "system" || m.role === "developer";
const imageUrls = (c) =>
  Array.isArray(c)
    ? c.flatMap((p) => (p?.type === "image_url" ? [p.image_url?.url ?? p.image_url] : p?.type === "input_image" ? [p.image_url?.url ?? p.image_url] : [])).filter((u) => typeof u === "string")
    : [];
// Images are compared by a hash of their URL/data so replayed history can be matched cheaply.
const imgSig = (u) => createHash("sha1").update(u).digest("hex").slice(0, 16);
const norm = (m) => ({
  role: m.role,
  content: text(m.content).trim(),
  calls: (m.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function?.name, args: t.function?.arguments ?? "" })),
  toolCallId: m.tool_call_id ?? "",
  images: imageUrls(m.content).map((url) => ({ url, sig: imgSig(url) })),
});
const splitMessages = (messages) => ({
  system: messages.filter(isSys).map((m) => text(m.content)).join("\n\n"),
  convo: messages.filter((m) => !isSys(m)).map(norm),
});

// Assistant messages with tool calls are compared by call ids only (clients often rewrite their text).
// Tool results are compared by tool_call_id only: agents such as Hermes shrink or dedupe old tool
// outputs in place, and the live session already holds the original result for that call id.
const sigs = (m) => m.images.map((i) => i.sig).join();
const sameMsg = (a, b) =>
  a.role === b.role &&
  (a.role === "assistant" && (a.calls.length || b.calls.length)
    ? a.calls.map((c) => c.id).join() === b.calls.map((c) => c.id).join()
    : a.role === "tool" && a.toolCallId
      ? a.toolCallId === b.toolCallId
      : a.content === b.content && a.toolCallId === b.toolCallId && sigs(a) === sigs(b));
const isPrefix = (prefix, all) => prefix.length <= all.length && prefix.every((m, i) => sameMsg(m, all[i]));

const renderMsg = (m) => {
  if (m.role === "tool") return `TOOL RESULT (${m.toolCallId}): ${m.content}`;
  const calls = m.calls.map((c) => `\n[tool call ${c.id}: ${c.name}(${c.args})]`).join("");
  return `${m.role.toUpperCase()}: ${m.content}${calls}`;
};

// Turns the new messages into a prompt plus image attachments (resolved to base64 blobs).
async function buildTurn(msgs) {
  const urls = msgs.flatMap((m) => m.images.map((i) => i.url));
  const attachments = [];
  for (const [i, url] of urls.entries()) {
    const { data, mimeType } = await loadImage(url);
    attachments.push({ type: "blob", data, mimeType, displayName: `image-${i + 1}` });
  }
  let k = 0;
  const label = (m) => (m.images.length ? ` ${m.images.map(() => `[image-${++k}]`).join(" ")}` : "");
  const body = msgs.map((m) => renderMsg(m) + label(m)).join("\n\n");
  const prompt =
    msgs.length === 1 && msgs[0].role === "user"
      ? msgs[0].content + (urls.length > 1 ? label(msgs[0]) : "")
      : msgs.some((m) => m.role === "tool")
        ? "Conversation so far, including tool calls that were ALREADY executed and their results. " +
          "Do not repeat those calls; use their results and continue from the last message.\n\n" + body
        : body;
  return { prompt: prompt || "Describe the attached image(s).", attachments };
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
async function loadImage(url) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (m) {
    const data = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString("base64");
    return { mimeType: m[1], data };
  }
  if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error("image_url must be a data: or http(s) URL"), { status: 400 });
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw Object.assign(new Error(`could not fetch image (${r.status}): ${url.slice(0, 100)}`), { status: 400 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("image too large"), { status: 400 });
  const mimeType = (r.headers.get("content-type") ?? "").split(";")[0] || "image/png";
  return { mimeType, data: buf.toString("base64") };
}

// ---------- sessions ----------
// One live Copilot session per conversation. A request whose messages extend a known
// session's recorded history continues that session (only new messages are sent), which
// keeps Copilot-side context and the prompt cache intact.
const entries = [];
const newTotals = () => ({ requests: 0, api_calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, nano_aiu: 0, cost_multiplier: 0 });

// Why entry `e` can't continue this request (null = it can). Used for matching and for logging.
function mismatch(e, model, system, convo, opts) {
  if (e.model !== model) return "model differs";
  if (e.system !== system) return "system prompt changed";
  if (e.opts !== opts) return "tools/reasoning options changed";
  if (e.history.length >= convo.length) return `history not longer than session (${convo.length} <= ${e.history.length})`;
  const at = e.history.findIndex((m, i) => !sameMsg(m, convo[i]));
  if (at >= 0) {
    const a = e.history[at], b = convo[at];
    const what = a.role !== b.role ? "role" : a.toolCallId !== b.toolCallId ? "tool_call_id"
      : a.calls.length || b.calls.length ? "tool call ids" : sigs(a) !== sigs(b) ? "images" : `content ${a.content.length}->${b.content.length} chars`;
    return `history diverges at message #${at} (${a.role} vs ${b.role}: ${what})`;
  }
  const rest = convo.slice(e.history.length);
  const results = rest.filter((m) => m.role === "tool");
  if (e.issued.length) {
    const missing = e.issued.filter((id) => !results.some((t) => t.toolCallId === id));
    if (missing.length) return `missing tool results for ${missing.join(",")}`;
    if (results.length !== rest.length) return "extra messages besides the awaited tool results";
  } else if (results.length) return "tool results for calls this session did not issue";
  if (e.busy) return "busy";
  return null;
}

function findEntry(model, system, convo, opts) {
  let best, closest, reason, busy = false;
  for (const e of entries) {
    const why = mismatch(e, model, system, convo, opts);
    if (!why) { if (!best || e.history.length > best.history.length) best = e; continue; }
    if (why === "busy") busy = true;
    // Remember the most relevant failed candidate for diagnostics.
    if (e.model === model && (!closest || e.lastUsed > closest.lastUsed)) { closest = e; reason = why; }
  }
  return { entry: best, closest, reason, busy };
}

// If the matching session is still finishing a previous request, wait for it instead of forking.
async function acquireEntry(model, system, convo, opts) {
  const deadline = Date.now() + BUSY_WAIT_MS;
  for (;;) {
    const r = findEntry(model, system, convo, opts);
    if (r.entry || !r.busy || Date.now() > deadline) return r;
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

function dropEntry(entry) {
  const i = entries.indexOf(entry);
  if (i >= 0) entries.splice(i, 1);
  entry.session.disconnect().catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const e of [...entries]) if (!e.busy && now - e.lastUsed > SESSION_TTL_MS) dropEntry(e);
}, 60_000).unref();

const contextOut = (c) => c && {
  used_tokens: c.currentTokens,
  limit_tokens: c.tokenLimit,
  percent: c.tokenLimit ? Math.round((c.currentTokens / c.tokenLimit) * 1000) / 10 : undefined,
  system_tokens: c.systemTokens,
  conversation_tokens: c.conversationTokens,
  tool_definition_tokens: c.toolDefinitionsTokens,
  messages: c.messagesLength,
};
const totalsOut = (t) => ({
  requests: t.requests,
  api_calls: t.api_calls,
  tokens: { prompt: t.prompt_tokens, completion: t.completion_tokens, cached: t.cached_tokens },
  cache_hit_ratio: t.prompt_tokens ? Math.round((t.cached_tokens / t.prompt_tokens) * 1000) / 1000 : 0,
  ai_units: t.nano_aiu / 1e9,
  cost_multiplier: t.cost_multiplier,
});
const sessionInfo = (e) => ({
  id: e.session.sessionId,
  model: e.model,
  actual_model: e.actualModel,
  reasoning_effort: e.effort,
  fusion_tier: e.fusionTier,
  context_tier: e.contextTier,
  created: new Date(e.createdAt).toISOString(),
  last_used: new Date(e.lastUsed).toISOString(),
  messages: e.history.length,
  awaiting_tool_results: e.issued,
  usage: totalsOut(e.totals),
  context: contextOut(e.context),
});

// ---------- turns ----------
// A turn runs inside one session.sendAndWait. When the model calls a client-supplied tool,
// the handler parks until a later HTTP request delivers the result, and the current HTTP
// request is answered with `tool_calls`.
function startTurn(entry, prompt, attachments = []) {
  const t = (entry.turn = { outcome: null, waiter: null, batch: [], timer: null });
  entry.session.sendAndWait({ prompt, ...(attachments.length && { attachments }) }, TURN_TIMEOUT_MS).then(
    (reply) => emit(entry, { type: "final", content: reply?.data?.content ?? "" }),
    (error) => emit(entry, { type: "error", error }),
  );
  return t;
}
function emit(entry, outcome) {
  const t = entry.turn;
  if (!t) return;
  if (t.waiter) { const w = t.waiter; t.waiter = null; w(outcome); } else t.outcome = outcome;
}
const takeOutcome = (entry) =>
  new Promise((resolve) => {
    const t = entry.turn;
    if (!t) return resolve({ type: "error", error: new Error("no active turn in this session") });
    if (t.outcome) { const o = t.outcome; t.outcome = null; resolve(o); } else t.waiter = resolve;
  });

function toolsFromRequest(entry, tools) {
  return tools
    .filter((t) => t.type === "function" && t.function?.name)
    .map((t) =>
      defineTool(t.function.name, {
        description: t.function.description ?? "",
        parameters: t.function.parameters ?? { type: "object", properties: {} },
        overridesBuiltInTool: true,
        skipPermission: true,
        handler: (args, inv) =>
          new Promise((resolve) => {
            const turn = entry.turn;
            entry.pending.set(inv.toolCallId, resolve);
            turn.batch.push({ id: inv.toolCallId, name: t.function.name, arguments: JSON.stringify(args ?? {}) });
            clearTimeout(turn.timer);
            turn.timer = setTimeout(() => {
              const calls = turn.batch;
              turn.batch = [];
              emit(entry, { type: "tool_calls", calls });
            }, TOOL_BATCH_MS);
          }),
      }),
    );
}

async function createEntry({ model, backendModel = model, system, opts, effort, fusionTier, contextTier, tools }) {
  const entry = {
    model, system, opts, effort, fusionTier, contextTier,
    history: [], busy: false, createdAt: Date.now(), lastUsed: Date.now(),
    pending: new Map(), issued: [], turn: null, onDelta: null,
    totals: newTotals(), cur: newTotals(), context: null, actualModel: undefined,
  };
  entry.session = await client.createSession({
    model: backendModel,
    streaming: true,
    ...(effort && { reasoningEffort: effort }),
    ...(contextTier && { contextTier }),
    onPermissionRequest: approveAll,
    tools: toolsFromRequest(entry, tools),
    // Only the client's own tools are exposed; Copilot's built-in shell/file tools stay off.
    availableTools: ["custom:*"],
    ...(system && { systemMessage: { mode: "replace", content: system } }),
  });
  entry.session.on((e) => {
    if (e.type === "assistant.message_delta") entry.onDelta?.(e.data.deltaContent);
    else if (e.type === "assistant.reasoning_delta") entry.onReasoning?.(e.data.reasoningId, e.data.deltaContent, false);
    else if (e.type === "assistant.reasoning") entry.onReasoning?.(e.data.reasoningId, e.data.content, true);
    else if (e.type === "session.usage_info") entry.context = e.data;
    else if (e.type === "assistant.usage") {
      const d = e.data, cached = d.cacheReadTokens ?? 0;
      entry.actualModel = d.model ?? entry.actualModel;
      for (const t of [entry.totals, entry.cur]) {
        t.api_calls++;
        t.prompt_tokens += (d.inputTokens ?? 0) + cached;
        t.completion_tokens += d.outputTokens ?? 0;
        t.cached_tokens += cached;
        t.nano_aiu += d.copilotUsage?.totalNanoAiu ?? 0;
        t.cost_multiplier += d.cost ?? 0;
      }
      // Copilot's content filter blocked (or cut short) the reply. The runtime then supplies a
      // synthetic assistant message ("The model returned no content because the response was
      // blocked by content filtering."), which must not reach the client as an ordinary answer.
      if (entry.cur && (d.contentFilterTriggered || d.finishReason === "content_filter")) entry.cur.content_filter = true;
    }
  });
  // SessionConfig does not serialize fusionTier; switch through the runtime RPC
  // before the first turn so the requested preference is actually applied.
  if (fusionTier) {
    try {
      await entry.session.setFusionTier(fusionTier);
    } catch (error) {
      await entry.session.disconnect().catch(() => {});
      throw error;
    }
  }
  entries.push(entry);
  return entry;
}

// ---------- HTTP helpers ----------
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const err = (res, status, message, type = "invalid_request_error") => json(res, status, { error: { message, type } });
async function readBody(req) {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

// ---------- model catalog ----------
let catalogCache, catalogPending;
async function catalog() {
  if (catalogCache && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.value;
  // Concurrent requests (several agent sessions) share one refresh instead of each opening a probe session.
  catalogPending ??= loadCatalog().finally(() => { catalogPending = undefined; });
  return catalogPending;
}
async function loadCatalog() {
  // Fusion/Auto tiers are only discoverable through a session, so use a throwaway one.
  const [models, session] = await Promise.all([client.listModels(), client.createSession({ onPermissionRequest: approveAll })]);
  let auto;
  try {
    auto = (await session.rpc.model.list()).auto;
  } finally {
    await session.disconnect().catch(() => {});
  }
  const fusionTiers = (auto?.tiers ?? [])
    .filter((t) => t.fusionTier)
    .map((t) => ({
      id: t.fusionTier, name: t.displayName, description: t.description,
      enabled: t.status?.enabled !== false, default: t.id === auto.defaultTier, promo: t.billing?.promo?.message,
    }));
  const data = models.map((m) => {
    const c = m.capabilities ?? {}, lim = c.limits ?? {}, sup = c.supports ?? {};
    // `auto` may route to any model, and the runtime enforces a smaller budget there than the
    // per-model catalog advertises, so it gets the configured safe window.
    const ctx = m.id === "auto" ? AUTO_CONTEXT_WINDOW : lim.max_context_window_tokens || undefined;
    const tiers = contextTiers(m);
    return {
      id: m.id, object: "model", created: 0, owned_by: m.vendor ?? "github-copilot", name: m.name,
      context_window: ctx, context_length: ctx,
      max_output_tokens: lim.max_output_tokens,
      capabilities: { streaming: sup.streaming, tool_calls: sup.tool_calls, vision: sup.vision, structured_outputs: sup.structured_outputs },
      reasoning_efforts: m.supportedReasoningEfforts ?? [],
      default_reasoning_effort: m.defaultReasoningEffort,
      enabled: m.policy?.state ? m.policy.state === "enabled" : true,
      price_category: m.modelPickerPriceCategory,
      ...(m.id === "auto" && { fusion_tiers: fusionTiers }),
      ...(tiers && { context_tiers: tiers }),
    };
  });
  // Context size (Copilot's "100K / 1M" picker): clients without a picker (Hermes) choose it
  // through the model ID, so each tier is also listed as `<model>-<size>`, e.g. claude-haiku-5.5-1m.
  for (const base of [...data]) {
    for (const tier of base.context_tiers ?? []) {
      if (data.some((m) => m.id === tier.model)) continue;
      const { context_tiers, ...rest } = base;
      data.push({
        ...rest, id: tier.model, name: `${base.name} (${tier.label})`,
        context_window: tier.context_window, context_length: tier.context_window,
        underlying_model: base.id, context_tier: tier.id,
      });
    }
  }
  // OpenAI model pickers (including Hermes) only see top-level model IDs.
  const autoModel = data.find((m) => m.id === "auto");
  if (autoModel) {
    for (const tier of fusionTiers.filter((t) => t.enabled)) {
      const id = tier.id === "standard" ? "fusion" : `fusion-${tier.id}`;
      if (data.some((m) => m.id === id)) continue;
      data.push({
        ...autoModel, id, name: tier.id === "standard" ? "Fusion" : `Fusion ${tier.name}`,
        underlying_model: "auto", fusion_tier: tier.id,
        description: tier.description, enabled: autoModel.enabled && tier.enabled,
      });
    }
  }
  catalogCache = { at: Date.now(), value: { data, fusionTiers } };
  return catalogCache.value;
}

// Copilot publishes per-tier prompt budgets in billing.tokenPrices (`longContext` = the 1M tier).
// Sessions without an explicit tier run on the long tier, so the base model ID keeps that behavior.
const sizeLabel = (t) => (t >= 850_000 ? `${Math.round(t / 1e6)}M` : `${Math.round(t / 1e3)}K`);
function contextTiers(m) {
  const tp = m.billing?.tokenPrices, lim = m.capabilities?.limits ?? {};
  const small = tp?.maxPromptTokens ?? tp?.contextMax;
  const longPrompt = tp?.longContext?.maxPromptTokens ?? tp?.longContext?.contextMax;
  if (m.id === "auto" || !small || !longPrompt || longPrompt <= small) return undefined;
  // The long tier's enforced limit is not in the catalog: on identical limits (936k prompt, 1M
  // window, 128k output) Haiku ran with 872k and Sonnet with 936k. Window minus output is the
  // lowest seen, so advertise that - clients compact slightly early instead of overflowing.
  const room = lim.max_context_window_tokens && lim.max_output_tokens ? lim.max_context_window_tokens - lim.max_output_tokens : Infinity;
  return [
    { id: "default", context_window: small, label: sizeLabel(small) },
    { id: "long_context", context_window: Math.min(longPrompt, room), label: sizeLabel(longPrompt) },
  ].map((t) => ({ ...t, model: `${m.id}-${t.label.toLowerCase()}` }));
}

async function models(res, id) {
  const { data } = await catalog();
  if (id) {
    const m = data.find((x) => x.id === id);
    return m ? json(res, 200, m) : err(res, 404, `Model '${id}' not found`);
  }
  json(res, 200, { object: "list", data });
}

// ---------- chat completions ----------
async function chat(req, res) {
  const started = Date.now();
  const body = await readBody(req);
  if (!Array.isArray(body.messages)) return err(res, 400, "'messages' is required");
  const model = body.model ?? DEFAULT_MODEL;
  const { system, convo } = splitMessages(body.messages);
  if (!convo.length) return err(res, 400, "at least one non-system message is required");

  // Extensions: `reasoning_effort` (OpenAI-standard), `fusion_tier` (Auto/Fusion models only) and
  // `context_tier` ("default" | "long_context", for models that offer a context size choice).
  let effort = body.reasoning_effort ?? undefined;
  let fusionTier = body.fusion_tier ?? undefined;
  let contextTier = body.context_tier ?? undefined;
  let backendModel = model;
  if (effort !== undefined || fusionTier !== undefined || contextTier !== undefined || model === "fusion" || model.startsWith("fusion-") || /-\d+[km]$/.test(model)) {
    const { data, fusionTiers } = await catalog();
    const info = data.find((m) => m.id === model);
    if (!info) return err(res, 404, `Model '${model}' not found`);
    if (info.underlying_model) {
      if (!info.enabled) return err(res, 400, `Model '${model}' is disabled`);
      if (info.fusion_tier) {
        if (fusionTier !== undefined && fusionTier !== info.fusion_tier)
          return err(res, 400, `Model '${model}' requires fusion_tier '${info.fusion_tier}'`);
        fusionTier = info.fusion_tier;
      }
      if (info.context_tier) {
        if (contextTier !== undefined && contextTier !== info.context_tier)
          return err(res, 400, `Model '${model}' requires context_tier '${info.context_tier}'`);
        contextTier = info.context_tier;
      }
      backendModel = info.underlying_model;
    }
    if (contextTier !== undefined && !CONTEXT_TIERS.includes(contextTier))
      return err(res, 400, `invalid context_tier '${contextTier}'; expected one of: ${CONTEXT_TIERS.join(", ")}`);
    if (contextTier !== undefined && !info.context_tier && !info.context_tiers)
      return err(res, 400, `Model '${model}' has no context size choice, so context_tier is not supported`);
    if (effort !== undefined && !KNOWN_EFFORTS.includes(effort))
      return err(res, 400, `invalid reasoning_effort '${effort}'; expected one of: ${KNOWN_EFFORTS.join(", ")}`);
    // Agents send one effort for every model; an effort this model can't use is ignored, not an error.
    if (effort !== undefined && !info.reasoning_efforts.includes(effort)) {
      log(dim(`  ignoring reasoning_effort=${effort}: '${model}' supports ${info.reasoning_efforts.join(", ") || "none"}`));
      effort = undefined;
    }
    if (fusionTier !== undefined && (backendModel !== "auto" || !fusionTiers.some((t) => t.id === fusionTier)))
      return err(res, 400, `fusion_tier applies to model 'auto' and must be one of: ${fusionTiers.map((t) => t.id).join(", ")}`);
  }
  const tools = (body.tools ?? []).filter((t) => t.type === "function" && t.function?.name);
  // The tool set is fixed per Copilot session, so it is part of the session identity.
  const toolSig = tools.map((t) => `${t.function.name}:${JSON.stringify(t.function.parameters ?? {})}`).join(";");
  const opts = `${effort ?? ""}|${fusionTier ?? ""}|${contextTier ?? ""}|${toolSig}`;

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null, extra = {}) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
  });

  const found = await acquireEntry(model, system, convo, opts);
  let entry = found.entry;
  const reused = !!entry;
  if (entry) entry.busy = true; // claim immediately so a concurrent request can't take it too
  const toSend = reused ? convo.slice(entry.history.length) : convo;
  // Tool results can only be handed to a live session that is waiting for them. Without one,
  // the whole transcript (including tool calls/results) is replayed as text in a new session.
  const toolResults = reused ? toSend.filter((m) => m.role === "tool") : [];
  const imageCount = toSend.reduce((s, m) => s + m.images.length, 0);
  let turn;
  try {
    if (imageCount && model !== "auto") {
      const info = (await catalog()).data.find((m) => m.id === model);
      if (info?.capabilities.vision === false) throw Object.assign(new Error(`Model '${model}' does not support image input`), { status: 400 });
    }
    // Resolve images before creating a session so bad URLs fail fast with a 400.
    turn = toolResults.length ? null : await buildTurn(toSend);
    entry ??= await createEntry({ model, backendModel, system, opts, effort, fusionTier, contextTier, tools });
  } catch (e) {
    if (entry) entry.busy = false;
    throw e;
  }
  entry.busy = true;
  if (!reused && found.closest && convo.length > 1)
    log(dim(`  not continuing session ${short(found.closest.session.sessionId)}: ${found.reason}`));
  entry.cur = newTotals();
  const sid = short(entry.session.sessionId);
  log(
    cyan("→"), `chat model=${model}`, effort ? `effort=${effort}` : "", fusionTier ? `fusion=${fusionTier}` : "", contextTier ? `context=${contextTier}` : "",
    `msgs=${body.messages.length} tools=${tools.length}${imageCount ? ` images=${imageCount}` : ""}${body.stream ? " stream" : ""}`,
    reused ? green(`session ${sid} (continued, +${toSend.length} msg)`) : yellow(`session ${sid} (new)`),
  );

  let aborted = false;
  res.on("close", () => {
    if (res.writableFinished || aborted) return;
    aborted = true;
    log(red("✗"), `client disconnected, dropping session ${sid}`);
    dropEntry(entry);
  });

  let sentText = "";
  const stream = !!body.stream;
  // Headers go out on the first streamed byte or after STREAM_HEADER_DELAY_MS, whichever is first.
  let headerTimer;
  const openStream = () => {
    clearTimeout(headerTimer);
    if (res.headersSent || !res.writable) return;
    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache",
      "x-copilot-session-id": entry.session.sessionId, "x-copilot-session-reused": String(reused), "x-copilot-messages-sent": String(toSend.length),
    });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
  };
  const write = (o) => { openStream(); return res.writable && res.write(`data: ${JSON.stringify(o)}\n\n`); };
  if (stream) headerTimer = setTimeout(openStream, STREAM_HEADER_DELAY_MS);
  entry.onDelta = (c) => {
    sentText += c;
    if (stream) write(chunk({ content: c }));
  };
  // Thinking is sent as `reasoning_content` (DeepSeek-style field Hermes, Open WebUI etc. render
  // as a thinking block). Deltas stream live; a complete `assistant.reasoning` event only adds
  // whatever wasn't streamed (some models send no deltas).
  let reasoning = "";
  const seen = new Map();
  entry.onReasoning = (rid, text, complete) => {
    if (!EMIT_REASONING || !text) return;
    const prev = seen.get(rid) ?? "";
    const add = complete ? (text.startsWith(prev) ? text.slice(prev.length) : prev ? "" : text) : text;
    if (!add) return;
    const piece = (!seen.has(rid) && reasoning ? "\n\n" : "") + add;
    seen.set(rid, prev + add);
    reasoning += piece;
    if (stream) write(chunk({ reasoning_content: piece }));
  };

  try {
    if (toolResults.length) {
      entry.issued = [];
      for (const m of toolResults) {
        entry.pending.get(m.toolCallId)?.(m.content);
        entry.pending.delete(m.toolCallId);
      }
    } else {
      startTurn(entry, turn.prompt, turn.attachments);
    }
    const outcome = await takeOutcome(entry);
    if (outcome.type === "error") throw outcome.error;
    if (aborted) return;

    // A filtered turn is reported the OpenAI way (finish_reason "content_filter") so clients treat
    // it as a refusal: not stored as the model's answer, and not retried as an empty reply. The
    // explanation stays in `content`.
    const filtered = outcome.type !== "tool_calls" && !!entry.cur.content_filter;
    const finishReason = outcome.type === "tool_calls" ? "tool_calls" : filtered ? "content_filter" : "stop";
    const content = outcome.type === "final" ? outcome.content : sentText;
    // Some Fusion-routed turns provide only the final message, with no deltas.
    if (stream && !sentText && content) {
      sentText = content;
      write(chunk({ content }));
    }
    const toolCalls = outcome.type === "tool_calls"
      ? outcome.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
      : undefined;
    entry.issued = toolCalls ? toolCalls.map((c) => c.id) : [];
    entry.history = [
      ...convo,
      { role: "assistant", content: (stream ? sentText : content).trim(), calls: toolCalls?.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments })) ?? [], toolCallId: "", images: [] },
    ];
    entry.lastUsed = Date.now();
    entry.totals.requests++;

    const cur = entry.cur;
    const usage = {
      prompt_tokens: cur.prompt_tokens, completion_tokens: cur.completion_tokens, total_tokens: cur.prompt_tokens + cur.completion_tokens,
      prompt_tokens_details: { cached_tokens: cur.cached_tokens },
    };
    const ms = Date.now() - started;
    const x_copilot = {
      session_id: entry.session.sessionId, session_reused: reused, messages_sent: toSend.length,
      model: entry.actualModel ?? model, duration_ms: ms, ...(filtered && { content_filter: true }),
      request: totalsOut(cur), session: totalsOut(entry.totals), context: contextOut(entry.context),
    };

    if (stream) {
      if (toolCalls) write(chunk({ tool_calls: toolCalls.map((c, index) => ({ index, ...c })) }));
      write(chunk({}, finishReason, { x_copilot }));
      if (body.stream_options?.include_usage) write({ id, object: "chat.completion.chunk", created, model, choices: [], usage, x_copilot });
      res.end("data: [DONE]\n\n");
    } else {
      json(res, 200, {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: content || (toolCalls ? null : ""), ...(reasoning && { reasoning_content: reasoning }), ...(toolCalls && { tool_calls: toolCalls }) }, finish_reason: finishReason }],
        usage, x_copilot,
      }, {
        "x-copilot-session-id": entry.session.sessionId, "x-copilot-session-reused": String(reused), "x-copilot-messages-sent": String(toSend.length),
        "x-copilot-ai-units": String(cur.nano_aiu / 1e9), "x-copilot-context-used": String(entry.context?.currentTokens ?? ""),
      });
    }

    const ctx = entry.context;
    log(
      green("←"), `200 ${sid} ${finishReason}${toolCalls ? `(${toolCalls.map((c) => c.function.name).join(",")})` : ""}`,
      `${(ms / 1000).toFixed(1)}s`, `model=${entry.actualModel ?? model}`,
      `in=${n(cur.prompt_tokens)} (cached ${n(cur.cached_tokens)}, ${cur.prompt_tokens ? Math.round((cur.cached_tokens / cur.prompt_tokens) * 100) : 0}%)`,
      `out=${n(cur.completion_tokens)}`, reasoning ? `think=${n(reasoning.length)} chars` : "", `cost=${aiu(cur.nano_aiu / 1e9)} AIU (x${cur.cost_multiplier})`,
      ctx ? `| ctx ${n(ctx.currentTokens)}/${n(ctx.tokenLimit)} (${Math.round((ctx.currentTokens / ctx.tokenLimit) * 100)}%)` : "",
      `| session: ${entry.totals.requests} req, ${aiu(entry.totals.nano_aiu / 1e9)} AIU`,
    );
    if (filtered) {
      // The Copilot session now holds the synthetic message, which the client won't keep, so the
      // session can't be continued: drop it instead of leaving it to the idle timeout.
      log(red("  blocked by Copilot's content filter;"), `dropping session ${sid}`);
      dropEntry(entry);
    }
  } catch (e) {
    // A failed turn leaves the session in an unknown state; drop it.
    dropEntry(entry);
    throw e;
  } finally {
    clearTimeout(headerTimer);
    entry.onDelta = null;
    entry.onReasoning = null;
    entry.busy = false;
  }
}

let lastRequest = Date.now(), inFlight = 0;
const server = http.createServer(async (req, res) => {
  lastRequest = Date.now();
  inFlight++;
  res.on("close", () => { inFlight--; lastRequest = Date.now(); });
  try {
    if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) return err(res, 401, "Invalid API key");
    await clientReady;
    const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "");
    if (req.method === "GET" && path === "/v1/models") return await models(res);
    if (req.method === "GET" && path.startsWith("/v1/models/")) return await models(res, decodeURIComponent(path.slice(11)));
    if (req.method === "GET" && path === "/v1/sessions") return json(res, 200, { object: "list", data: entries.map(sessionInfo) });
    if (req.method === "GET" && path.startsWith("/v1/sessions/")) {
      const e = entries.find((x) => x.session.sessionId === path.slice(13));
      return e ? json(res, 200, { ...sessionInfo(e), runtime_model: await e.session.rpc.model.getCurrent() }) : err(res, 404, "Session not found");
    }
    if (req.method === "POST" && path === "/v1/chat/completions") return await chat(req, res);
    err(res, 404, `Unknown route ${req.method} ${path}`);
  } catch (e) {
    log(red("✗"), `error: ${e?.message ?? e}`);
    let message = String(e?.message ?? e), status = e?.status, code;
    // Copilot's "prompt budget" wording isn't recognised by agents' overflow detection; rephrase it the
    // OpenAI way (400 + context_length_exceeded + "maximum context length is N") so they compact.
    const over = /prompt budget[^(]*\((\d+) tokens; limit (\d+)\)/i.exec(message);
    if (over) {
      status = 400; code = "context_length_exceeded";
      message = `This model's maximum context length is ${over[2]} tokens. However, your messages resulted in ${over[1]} tokens. Please reduce the length of the messages. (${message})`;
    }
    const error = { message, type: status ? "invalid_request_error" : "server_error", ...(code && { code }) };
    if (!res.headersSent) json(res, status ?? 500, { error });
    // Mid-stream failure: send an SSE error event (OpenAI SDKs raise it) instead of a bare close.
    else if (res.writable) res.end(`data: ${JSON.stringify({ error })}\n\n`);
    else res.end();
  }
});
server.on("error", (e) => {
  // Another bridge instance (e.g. started by a parallel Hermes process) already owns the port.
  if (e.code === "EADDRINUSE") { console.error(`port ${PORT} already in use; another bridge is serving it`); process.exit(3); }
  throw e;
});
server.listen(PORT, "127.0.0.1", function () {
  clientReady = client.start();
  clientReady.then(() => {
    console.log(`OpenAI-compatible API on http://127.0.0.1:${this.address().port}/v1`);
    log(dim("session lifecycle, tokens, cache hits, cost (AIU) and context usage are logged per request"));
  }, (e) => { console.error(`Copilot client failed to start: ${e?.message ?? e}`); process.exit(1); });
});
if (IDLE_EXIT_MS > 0) {
  setInterval(() => {
    if (inFlight === 0 && !entries.some((e) => e.busy) && Date.now() - lastRequest > IDLE_EXIT_MS) {
      log(yellow(`idle for ${Math.round(IDLE_EXIT_MS / 60000)} min, exiting`));
      shutdown("idle");
    }
  }, 30_000).unref();
}

// Graceful stop, but never hang: client.stop() can block on sessions parked waiting for tool
// results, so cap it at 3 s. A second Ctrl+C exits immediately.
let stopping = false;
const shutdown = (sig) => {
  if (stopping) process.exit(130);
  stopping = true;
  log(yellow(`${sig} received, stopping (press Ctrl+C again to force)…`));
  setTimeout(() => process.exit(0), 3000).unref();
  client.stop().catch(() => {}).finally(() => process.exit(0));
};
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => shutdown(sig));
