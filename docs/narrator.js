// The AI Dungeon Master voice. Runs in the room host's browser.
// Providers, in order: the host's own Anthropic key (optional) -> free keyless AI -> built-in narrator.
// Every AI reply must pass checkNarration(); anything else falls back to the built-in narrator.
import { SYSTEM, EXEMPLARS, checkNarration, templateNarration } from "./engine.js";

export const stats = { ai: 0, aiRetry: 0, builtin: 0, rejected: {}, lastError: "" };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
};

/** "free" (default), "claude" (own key) or "off". */
export function narratorMode() {
  const m = store.get("dl:narrator") || "free";
  if (m === "claude" && !store.get("dl:anthropicKey")) return "free";
  return m;
}

const cond = (hp, max) => (hp <= 0 ? "down" : hp >= max ? "unhurt" : hp / max > 0.5 ? "wounded" : "badly wounded");
/** Exemplars are authored with HP for readability; the model sees the same shape as live rounds. */
export const exemplarContext = (c) => ({
  ...c,
  party: c.party.map((p) => ({ name: p.name, cls: p.cls, condition: cond(p.hp, p.maxHp) })),
  enemies: c.enemies.map((e) => ({ name: e.name, condition: cond(e.hp, e.maxHp) })),
});
const fewshot = (n) => EXEMPLARS.slice(0, n).flatMap((x) => [
  { role: "user", content: JSON.stringify(exemplarContext(x.context)) },
  { role: "assistant", content: JSON.stringify({ narration: x.narration }) },
]);

function parse(raw) {
  if (!raw) return null;
  try {
    const s = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const o = JSON.parse(s);
    return typeof o.narration === "string" ? o.narration.trim() : null;
  } catch {
    // some models ignore JSON mode: accept plain prose and let the guard judge it
    const plain = raw.replace(/^["'\s]+|["'\s]+$/g, "").trim();
    return plain.length > 20 && !plain.includes("{") ? plain : null;
  }
}

async function timed(url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// ---------- Provider: Anthropic (host's own key, stays in their browser) ----------
async function claude(messages) {
  const key = store.get("dl:anthropicKey");
  const res = await timed("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: store.get("dl:model") || "claude-haiku-5-5", max_tokens: 300, temperature: 0.8, system: SYSTEM, messages }),
  }, 12000);
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return data?.content?.[0]?.text ?? null;
}

// ---------- Provider: free keyless AI (best effort, rate limited) ----------
let freeBlockedUntil = 0;
let freeLastCall = 0;
async function free(messages) {
  const now = Date.now();
  if (now < freeBlockedUntil) throw new Error("free AI cooling down");
  if (now - freeLastCall < 16000) throw new Error("free AI rate limit");
  freeLastCall = now;
  try {
    const res = await timed("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai", temperature: 0.8, private: true, referrer: "dungeon-lobby",
        messages: [{ role: "system", content: SYSTEM }, ...messages],
      }),
    }, 15000);
    if (!res.ok) throw new Error(`free AI ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) {
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? null;
    }
    return await res.text();
  } catch (e) {
    freeBlockedUntil = Date.now() + 120000; // back off 2 minutes after any failure
    throw e;
  }
}

/** Narrate one resolved round (or a scene intro). Never throws. */
export async function narrate(ctx) {
  const mode = narratorMode();
  if (mode !== "off") {
    const call = mode === "claude" ? claude : free;
    const payload = { ...ctx };
    delete payload.intro;
    const msgs = [...fewshot(mode === "claude" ? EXEMPLARS.length : 2), { role: "user", content: JSON.stringify(payload) }];
    const tries = mode === "claude" ? 2 : 1;
    for (let i = 0; i < tries; i++) {
      try {
        const raw = await call(msgs);
        const text = parse(raw);
        const why = text === null ? "bad_json" : checkNarration(text, ctx);
        if (text && !why) {
          i === 0 ? stats.ai++ : stats.aiRetry++;
          return { text, source: mode === "claude" ? "claude" : "free-ai" };
        }
        const tag = String(why).split(":")[0];
        stats.rejected[tag] = (stats.rejected[tag] || 0) + 1;
        msgs.push({ role: "assistant", content: raw || "" });
        msgs.push({ role: "user", content: `REJECTED by the rules checker: ${why}. Rewrite following every rule. Reply with ONLY the JSON object.` });
      } catch (e) {
        stats.lastError = String(e && e.message || e);
        break;
      }
    }
  }
  stats.builtin++;
  return { text: ctx.intro || templateNarration(ctx), source: "built-in" };
}
