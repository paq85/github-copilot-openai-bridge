// Live acceptance tests: spawns the bridge against the real Copilot runtime and
// behaves like a stateless agent client (e.g. Hermes) that resends full history.
// Run: npm test   (requires a logged-in Copilot CLI; MODEL env overrides the model)
import { test, before, after } from "node:test";
import http from "node:http";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const MODEL = process.env.MODEL ?? "auto";
let proc, base;

before(async () => {
  proc = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  base = await new Promise((resolve, reject) => {
    proc.once("exit", (c) => reject(new Error(`server exited ${c}`)));
    proc.stdout.on("data", (d) => {
      if (process.env.DEBUG_BRIDGE) process.stdout.write(d);
      const m = /(http:\/\/127\.0\.0\.1:\d+\/v1)/.exec(String(d));
      if (m) resolve(m[1]);
    });
  });
});
after(() => proc?.kill());

async function chat(messages, extra = {}) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, ...extra }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const h = (n) => res.headers.get(n);
  const meta = { sessionId: h("x-copilot-session-id"), reused: h("x-copilot-session-reused") === "true", sent: Number(h("x-copilot-messages-sent")) };
  if (extra.stream) {
    let content = "", usage, chunks = 0;
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const j = JSON.parse(line.slice(6));
      chunks++;
      content += j.choices[0]?.delta?.content ?? "";
      if (j.usage) usage = j.usage;
    }
    return { ...meta, content, usage, chunks };
  }
  const j = await res.json();
  return { ...meta, content: j.choices[0].message.content, usage: j.usage };
}

// Appends the assistant reply and next user message, as a stateless client would.
const next = (msgs, r, user) => [...msgs, { role: "assistant", content: r.content }, { role: "user", content: user }];

test("model catalog exposes reasoning efforts and Fusion tiers", async () => {
  const list = await (await fetch(`${base}/models`)).json();
  assert.equal(list.object, "list");
  const auto = list.data.find((m) => m.id === "auto");
  assert.ok(auto.fusion_tiers.length > 0, "auto must list fusion tiers");
  for (const t of auto.fusion_tiers) assert.ok(t.id && t.name);
  const reasoning = list.data.filter((m) => m.reasoning_efforts.length);
  assert.ok(reasoning.length > 0, "some model must list reasoning efforts");
  const one = await (await fetch(`${base}/models/${reasoning[0].id}`)).json();
  assert.deepEqual(one.reasoning_efforts, reasoning[0].reasoning_efforts);
  assert.equal((await fetch(`${base}/models/nope`)).status, 404);
});

test("Fusion modes are separate discoverable models", async () => {
  const { data } = await (await fetch(`${base}/models`)).json();
  const auto = data.find((m) => m.id === "auto");
  for (const [id, tier, name] of [["fusion", "standard", "Fusion"], ["fusion-high", "high", "Fusion High"]]) {
    const model = data.find((m) => m.id === id);
    assert.ok(model, `${id} must be a separate model`);
    assert.equal(model.name, name);
    assert.equal(model.underlying_model, "auto");
    assert.equal(model.fusion_tier, tier);
    assert.equal(model.enabled, auto.fusion_tiers.find((t) => t.id === tier).enabled);
    assert.equal(model.context_window, auto.context_window);
    assert.deepEqual(await (await fetch(`${base}/models/${id}`)).json(), model);
  }
  for (const tier of auto.fusion_tiers.filter((t) => !t.enabled)) {
    const id = tier.id === "standard" ? "fusion" : `fusion-${tier.id}`;
    assert.ok(!data.some((m) => m.id === id), "disabled tiers must not be offered as models");
  }
  assert.equal(new Set(data.map((m) => m.id)).size, data.length);
});

test("Fusion model IDs select their tiers and preserve session continuation", async () => {
  const messages = [{ role: "user", content: "Remember FUSION-7731. Reply only OK." }];
  const sessions = [];
  for (const [model, tier, stream] of [["fusion", "standard", false], ["fusion-high", "high", true]]) {
    const first = await chat(messages, { model, stream, reasoning_effort: "xhigh" });
    const info = await (await fetch(`${base}/sessions/${first.sessionId}`)).json();
    assert.equal(info.model, model);
    assert.equal(info.fusion_tier, tier);
    assert.equal(info.runtime_model?.fusionTier, tier, "Copilot runtime must confirm the selected tier");
    const second = await chat(next(messages, first, "What code did I ask you to remember?"), { model, stream });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.reused, true);
    assert.match(second.content, /FUSION-7731/);
    sessions.push(first.sessionId);
  }
  assert.notEqual(...sessions, "different Fusion modes must not share a session");
  const conflict = await fetch(`${base}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fusion-high", fusion_tier: "standard", messages }),
  });
  assert.equal(conflict.status, 400, "explicit tier must not silently override the chosen model");
});

test("context size variants are listed and pin the Copilot context tier", async () => {
  const { data } = await (await fetch(`${base}/models`)).json();
  const baseModel = data.find((m) => m.context_tiers?.length === 2);
  if (!baseModel) return; // the account's catalog offers no context size choice
  const sizes = {};
  for (const tier of baseModel.context_tiers) {
    const v = data.find((m) => m.id === tier.model);
    assert.ok(v, `${tier.model} must be listed as its own model`);
    assert.equal(v.underlying_model, baseModel.id);
    assert.equal(v.context_tier, tier.id);
    assert.equal(v.context_length, tier.context_window);
    const r = await chat([{ role: "user", content: "Reply only OK." }], { model: v.id });
    const info = await (await fetch(`${base}/sessions/${r.sessionId}`)).json();
    assert.equal(info.context_tier, tier.id);
    // The long tier's enforced limit varies per model (Haiku 872k, Sonnet 936k on identical catalog
    // limits), so the advertised window is a safe lower bound; the default tier is exact.
    if (tier.id === "default") assert.equal(info.context?.limit_tokens, v.context_length);
    else assert.ok(v.context_length <= info.context?.limit_tokens, "advertised window must never exceed Copilot's enforced limit");
    sizes[tier.id] = info.context.limit_tokens;
  }
  assert.ok(sizes.default < sizes.long_context);
  const post = (b) => fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Say ok." }], ...b }) });
  assert.equal((await post({ model: baseModel.context_tiers[1].model, context_tier: "default" })).status, 400);
  assert.equal((await post({ model: baseModel.id, context_tier: "huge" })).status, 400);
  assert.equal((await post({ model: "auto", context_tier: "long_context" })).status, 400);
});

test("reasoning_effort and fusion_tier are validated and applied", async () => {
  const { data } = await (await fetch(`${base}/models`)).json();
  const auto = data.find((m) => m.id === "auto");
  const m = data.find((x) => x.reasoning_efforts.includes("low"));
  const post = (b) => fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Say ok." }], ...b }) });
  assert.equal((await post({ model: m.id, reasoning_effort: "bogus" })).status, 400);
  const lenient = await post({ model: "auto", reasoning_effort: "xhigh" });
  assert.equal(lenient.status, 200, "an effort the model doesn't support must be ignored, not rejected");
  assert.equal((await post({ model: m.id, fusion_tier: auto.fusion_tiers[0].id })).status, 400);
  const ok1 = await post({ model: m.id, reasoning_effort: "low" });
  assert.equal(ok1.status, 200, await ok1.text());
  const ok2 = await post({ model: "auto", fusion_tier: auto.fusion_tiers[0].id });
  assert.equal(ok2.status, 200, await ok2.text());
});

test("agent tool-calling loop works across requests in one session (Hermes-style)", async () => {
  const tools = [{
    type: "function",
    function: {
      name: "add_numbers",
      description: "Adds two integers and returns the sum. Always use this for arithmetic.",
      parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] },
    },
  }];
  const raw = async (messages, extra = {}) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, tools, ...extra }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return { res, body: await res.json() };
  };
  let msgs = [
    { role: "system", content: "You are an agent. Use the provided tools for any arithmetic." },
    { role: "user", content: "What is 4817 + 9265? Use the add_numbers tool, then state the result." },
  ];
  const r1 = await raw(msgs);
  const choice = r1.body.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  const call = choice.message.tool_calls[0];
  assert.equal(call.function.name, "add_numbers");
  const args = JSON.parse(call.function.arguments);
  assert.deepEqual([args.a, args.b].sort(), [4817, 9265]);

  msgs = [...msgs, choice.message, { role: "tool", tool_call_id: call.id, content: String(args.a + args.b) }];
  const r2 = await raw(msgs);
  assert.equal(r2.res.headers.get("x-copilot-session-id"), r1.res.headers.get("x-copilot-session-id"), "tool result must continue the same session");
  assert.equal(r2.res.headers.get("x-copilot-session-reused"), "true");
  assert.equal(r2.body.choices[0].finish_reason, "stop");
  assert.match(r2.body.choices[0].message.content.replace(/[,\s]/g, ""), /14082/);

  // Follow-up user turn after the tool exchange keeps going in the same session.
  msgs = [...msgs, r2.body.choices[0].message, { role: "user", content: "Thanks. Reply with just 'done'." }];
  const r3 = await raw(msgs);
  assert.equal(r3.res.headers.get("x-copilot-session-id"), r1.res.headers.get("x-copilot-session-id"));
  assert.equal(r3.res.headers.get("x-copilot-messages-sent"), "1");

  // Cost/context info is exposed per request and per session.
  const x = r3.body.x_copilot;
  assert.ok(x.request.tokens.prompt > 0 && x.session.requests === 3);
  assert.ok(x.context.used_tokens > 0 && x.context.limit_tokens > 0, "context usage must be reported");
  assert.ok(typeof x.session.ai_units === "number");
  const info = await (await fetch(`${base}/sessions/${x.session_id}`)).json();
  assert.equal(info.usage.requests, 3);
  assert.ok(info.context.percent >= 0);
  const all = await (await fetch(`${base}/sessions`)).json();
  assert.ok(all.data.some((s) => s.id === x.session_id));
});

test("tool calls are streamed in OpenAI delta format", async () => {
  const tools = [{ type: "function", function: { name: "get_secret", description: "Returns the secret number. Must be called to learn it.", parameters: { type: "object", properties: {} } } }];
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: true, tools, messages: [{ role: "user", content: "Call get_secret and tell me the number." }] }),
  });
  const chunks = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const tc = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(tc[0].function.name, "get_secret");
  assert.ok(tc[0].id);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("tool results for an unknown session are replayed into a new session instead of failing", async () => {
  // Reproduces Hermes sending tool results the bridge has no live session for (restart, eviction, edited history).
  const tools = [{ type: "function", function: { name: "lookup_code", description: "Returns the access code.", parameters: { type: "object", properties: {} } } }];
  const messages = [
    { role: "system", content: "You are an agent." },
    { role: "user", content: "Look up the access code and tell me what it is." },
    { role: "assistant", content: null, tool_calls: [{ id: "call_orphan_1", type: "function", function: { name: "lookup_code", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_orphan_1", content: "ZEBRA-4471" },
  ];
  for (const stream of [false, true]) {
    const r = await chat(messages, { tools, stream });
    assert.equal(r.reused, false);
    assert.match(r.content, /ZEBRA-4471/);
  }
});

test("model thinking is exposed as reasoning_content (stream and non-stream)", async () => {
  const { data } = await (await fetch(`${base}/models`)).json();
  const model = ["claude-haiku-5.5", "gpt-6-luna"].find((id) => data.some((m) => m.id === id && m.reasoning_efforts.includes("high")));
  if (!model) return; // no known thinking model available on this account
  const body = (stream) => JSON.stringify({ model, stream, reasoning_effort: "high", messages: [{ role: "user", content: "Is 391 prime? Reason it out, then answer yes or no." }] });
  const post = (stream) => fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: body(stream) });

  const lines = (await (await post(true)).text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const deltas = lines.map((c) => c.choices[0]?.delta ?? {});
  const think = deltas.map((d) => d.reasoning_content ?? "").join("");
  assert.ok(think.length > 0, "streamed reasoning_content expected");
  assert.ok(deltas.findIndex((d) => d.reasoning_content) < deltas.findIndex((d) => d.content), "thinking streams before the answer");
  assert.ok(!deltas.map((d) => d.content ?? "").join("").includes(think.slice(0, 40)), "thinking must not leak into content");

  const j = await (await post(false)).json();
  assert.ok(j.choices[0].message.reasoning_content?.length > 0, "non-stream message.reasoning_content expected");
  assert.match(j.choices[0].message.content, /no|17|23/i);
});

// Minimal solid-colour PNG encoder (no dependencies).
function solidPng(r, g, b, size = 96) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("images are analysed (data URL and http URL) and stay in the same session", async () => {
  const red = solidPng(255, 0, 0), blue = solidPng(0, 0, 255);
  const srv = http.createServer((_, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(blue); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try {
    const dataUrl = `data:image/png;base64,${red.toString("base64")}`;
    let msgs = [{ role: "user", content: [
      { type: "text", text: "What single colour fills this image? Answer with one lowercase word." },
      { type: "image_url", image_url: { url: dataUrl } },
    ] }];
    const t1 = await chat(msgs);
    assert.match(t1.content, /red/i);

    // Replayed history (image part included) must match, so only the new message is sent.
    msgs = next(msgs, t1, [
      { type: "text", text: "Now what colour is this second image? One lowercase word." },
      { type: "image_url", image_url: { url: `http://127.0.0.1:${srv.address().port}/b.png` } },
    ]);
    const t2 = await chat(msgs);
    assert.equal(t2.sessionId, t1.sessionId);
    assert.equal(t2.sent, 1);
    assert.match(t2.content, /blue/i);
  } finally {
    srv.close();
  }

  const bad = await fetch(`${base}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "ftp://nope" } }] }] }),
  });
  assert.equal(bad.status, 400);
});

test("history-resending client continues one Copilot session and sends only new messages", async () => {
  const sys = { role: "system", content: "You are a terse assistant. Answer in as few words as possible." };
  let msgs = [sys, { role: "user", content: "Remember this secret code word: ZEBRA-7731. Reply only 'ok'." }];
  const t1 = await chat(msgs);
  assert.equal(t1.reused, false);
  assert.equal(t1.sent, 1);

  msgs = next(msgs, t1, "What is the secret code word? Reply with just the word.");
  const t2 = await chat(msgs);
  assert.equal(t2.reused, true, "turn 2 must reuse the session");
  assert.equal(t2.sessionId, t1.sessionId);
  assert.equal(t2.sent, 1, "only the new user message may be forwarded");
  assert.match(t2.content, /ZEBRA-7731/);

  msgs = next(msgs, t2, "Repeat the code word once more, lowercase.");
  const t3 = await chat(msgs, { stream: true });
  assert.equal(t3.sessionId, t1.sessionId, "streaming turn must stay in the same session");
  assert.equal(t3.sent, 1);
  assert.ok(t3.chunks > 2);
  assert.match(t3.content, /zebra-7731/i);
});

test("diverging history starts a new session instead of corrupting the old one", async () => {
  const a = await chat([{ role: "user", content: "Remember: the fruit is KIWI. Reply 'ok'." }]);
  const b = await chat([{ role: "user", content: "Remember: the fruit is MANGO. Reply 'ok'." }]);
  assert.notEqual(a.sessionId, b.sessionId);

  // Edited history (client rewrote the assistant reply) must not match session a.
  const forked = await chat([
    { role: "user", content: "Remember: the fruit is KIWI. Reply 'ok'." },
    { role: "assistant", content: "something the model never said" },
    { role: "user", content: "Which fruit? One word." },
  ]);
  assert.equal(forked.reused, false);
  assert.notEqual(forked.sessionId, a.sessionId);
});

test("concurrent conversations stay isolated", async () => {
  const mk = async (word) => {
    let msgs = [{ role: "user", content: `Remember the word ${word}. Reply 'ok'.` }];
    const t1 = await chat(msgs);
    msgs = next(msgs, t1, "What word did I ask you to remember? Reply with just the word.");
    const t2 = await chat(msgs);
    return { t1, t2, word };
  };
  const [x, y] = await Promise.all([mk("OSTRICH"), mk("WALRUS")]);
  assert.notEqual(x.t1.sessionId, y.t1.sessionId);
  for (const r of [x, y]) {
    assert.equal(r.t2.sessionId, r.t1.sessionId);
    assert.match(r.t2.content, new RegExp(r.word, "i"));
  }
});

test("prompt cache is used on continued turns and reported as cached_tokens", async () => {
  // Large stable prefix so the provider's cache threshold is exceeded.
  const filler = Array.from({ length: 400 }, (_, i) => `Rule ${i}: always keep answers short; reference id ${i * 7919}.`).join("\n");
  let msgs = [
    { role: "system", content: `You are a terse assistant.\n${filler}` },
    { role: "user", content: "Say 'one'." },
  ];
  const t1 = await chat(msgs, { stream: true, stream_options: { include_usage: true } });
  assert.ok(t1.usage.prompt_tokens > 1000, `expected a large prompt, got ${t1.usage.prompt_tokens}`);

  let cached = 0;
  let last = t1;
  for (const word of ["two", "three"]) {
    msgs = next(msgs, last, `Say '${word}'.`);
    last = await chat(msgs, { stream: true, stream_options: { include_usage: true } });
    assert.equal(last.sessionId, t1.sessionId);
    assert.ok(last.usage, "usage must be reported");
    cached = Math.max(cached, last.usage.prompt_tokens_details?.cached_tokens ?? 0);
  }
  assert.ok(cached > 0, "continued turns must hit the prompt cache (cached_tokens > 0)");
});

