import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const PORT = 18799, base = `http://127.0.0.1:${PORT}/v1`;
const start = () => spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: String(PORT), NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
const p1 = start(); let logs = "";
p1.stdout.on("data", (d) => (logs += d));
await new Promise((r) => { const t = setInterval(() => { if (logs.includes("OpenAI-compatible")) { clearInterval(t); r(); } }, 100); });
// 1) port race: second instance must exit 3 quickly
const p2 = start(); const code = await new Promise((r) => p2.on("exit", r)); assert.equal(code, 3); console.log("race: second instance exit", code);
const tools = [{ type: "function", function: { name: "get_word", description: "Returns the secret word", parameters: { type: "object", properties: {} } } }];
async function call(messages, stream = true) {
  const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fusion", messages, tools, stream }) });
  if (!stream || r.status !== 200) return { status: r.status, body: await r.text(), reused: r.headers.get("x-copilot-session-reused") };
  let content = "", calls = [], finish = null, error = null;
  for (const line of (await r.text()).split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const j = JSON.parse(line.slice(6));
    if (j.error) error = j.error;
    const c = j.choices?.[0]; if (!c) continue;
    content += c.delta?.content ?? ""; if (c.delta?.tool_calls) calls.push(...c.delta.tool_calls); finish = c.finish_reason ?? finish;
  }
  return { status: 200, content, calls, finish, error, reused: r.headers.get("x-copilot-session-reused") };
}
async function convo(tag) {
  const sys = { role: "system", content: `You are test agent ${tag}. Use tools when asked.` };
  const m = [sys, { role: "user", content: `Call get_word, then reply with exactly: ${tag}-<word>` }];
  const a = await call(m); assert.equal(a.finish, "tool_calls", JSON.stringify(a));
  const tc = a.calls[0];
  m.push({ role: "assistant", content: a.content, tool_calls: [{ id: tc.id, type: "function", function: tc.function }] });
  m.push({ role: "tool", tool_call_id: tc.id, content: `the secret word is banana${tag} `.repeat(30) });
  const b = await call(m); assert.equal(b.finish, "stop"); assert.equal(b.reused, "true");
  // Hermes-style in-place shrink of the old tool result, then a new user turn
  m[3] = { ...m[3], content: "[old tool output cleared]" };
  m.push({ role: "assistant", content: b.content }, { role: "user", content: "Now reply with exactly: done" });
  const c = await call(m); assert.equal(c.reused, "true", "must continue session after tool-result shrink");
  return `${tag}: ${b.content.trim()} | ${c.content.trim()}`;
}
// 2) three parallel conversations
const res = await Promise.all(["A", "B", "C"].map(convo)); console.log(res.join("\n"));
// 3) oversized prompt must be a real HTTP error, not an empty 200 stream
const big = "word ".repeat(260_000);
const o = await call([{ role: "user", content: big }]); console.log("oversize:", o.status, String(o.body ?? o.error?.message).slice(0, 160));
assert.equal(o.status, 400); assert.match(o.body, /context_length_exceeded/);
p1.kill(); console.log("ALL OK"); process.exit(0);
