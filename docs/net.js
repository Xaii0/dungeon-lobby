// Message bus used by every browser. Same tiny interface for three transports:
//   mqtt   - public MQTT broker over secure WebSocket (the live site; no accounts, no server of ours)
//   local  - BroadcastChannel between tabs of one browser (offline testing)
//   memory - in-process broker (automated tests in Node)
// Interface: { id, broker, publish(topic, obj|null, retain), subscribe(t), unsubscribe(t), on(evt, cb), end() }
//   events: "message" (topic, obj|null), "status" ("online" | "offline" | "reconnecting")

export const NS = "xaii0-dungeon-lobby-5467/v1";
export const T = {
  list: (code) => `${NS}/list/${code}`,
  listAll: () => `${NS}/list/+`,
  state: (code) => `${NS}/r/${code}/s`,
  events: (code) => `${NS}/r/${code}/e`,
  input: (code) => `${NS}/r/${code}/i`,
  client: (cid) => `${NS}/c/${cid}`,
};

export const BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://test.mosquitto.org:8081",
];

export function randomId(len = 16) {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const g = globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(len)) : null;
  for (let i = 0; i < len; i++) s += a[(g ? g[i] : Math.floor(Math.random() * 256)) % a.length];
  return s;
}

export function topicMatches(filter, topic) {
  const f = filter.split("/"), t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function emitter() {
  const h = { message: [], status: [] };
  return {
    on(evt, cb) { (h[evt] || (h[evt] = [])).push(cb); },
    off(evt, cb) { const a = h[evt] || []; const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); },
    emit(evt, ...a) { for (const cb of h[evt] || []) { try { cb(...a); } catch (e) { console.error(e); } } },
  };
}

const MAX_BYTES = 64 * 1024;
function decode(s) {
  if (!s) return null;
  if (s.length > MAX_BYTES) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

// ---------------- Memory transport (tests) ----------------
export class MemoryBroker {
  constructor() { this.clients = new Set(); this.retained = new Map(); }
  route(topic, obj, retain) {
    const raw = obj == null ? "" : JSON.stringify(obj);
    if (retain) raw ? this.retained.set(topic, raw) : this.retained.delete(topic);
    for (const x of this.clients) queueMicrotask(() => x.alive && x.deliver(topic, raw));
  }
  connect({ will } = {}) {
    const broker = this, em = emitter(), subs = new Set();
    const c = {
      id: randomId(), broker: "memory", subs, alive: true,
      deliver(topic, raw) { for (const f of subs) if (topicMatches(f, topic)) { const o = decode(raw); if (o !== undefined) em.emit("message", topic, o); return; } },
      publish(topic, obj, retain = false) { if (c.alive) broker.route(topic, obj, retain); },
      subscribe(f) {
        subs.add(f);
        for (const [t, raw] of broker.retained) if (topicMatches(f, t)) queueMicrotask(() => { const o = decode(raw); if (o !== undefined && c.alive) em.emit("message", t, o); });
      },
      unsubscribe(f) { subs.delete(f); },
      on: em.on, off: em.off,
      end() { c.alive = false; broker.clients.delete(c); },
      /** test helper: abrupt connection loss -> broker publishes the will */
      drop() { c.end(); if (will) broker.route(will.topic, will.payload, true); },
    };
    this.clients.add(c);
    queueMicrotask(() => em.emit("status", "online"));
    return c;
  }
}

// ---------------- Local transport (tabs of one browser) ----------------
export function connectLocal({ will } = {}) {
  const em = emitter(), subs = new Set(), id = randomId();
  const ch = new BroadcastChannel("dungeon-lobby-bus");
  const RKEY = "dl:retained";
  const readR = () => { try { return JSON.parse(localStorage.getItem(RKEY) || "{}"); } catch { return {}; } };
  const writeR = (o) => { try { localStorage.setItem(RKEY, JSON.stringify(o)); } catch {} };
  const deliver = (topic, raw) => { for (const f of subs) if (topicMatches(f, topic)) { const o = decode(raw); if (o !== undefined) em.emit("message", topic, o); return; } };
  ch.onmessage = (m) => deliver(m.data.topic, m.data.raw);
  const bus = {
    id, broker: "local",
    publish(topic, obj, retain = false) {
      const raw = obj == null ? "" : JSON.stringify(obj);
      if (retain) { const r = readR(); if (raw) r[topic] = raw; else delete r[topic]; writeR(r); }
      ch.postMessage({ topic, raw });
      setTimeout(() => deliver(topic, raw), 0); // also to our own subscriptions, like MQTT
    },
    subscribe(f) { subs.add(f); const r = readR(); for (const t in r) if (topicMatches(f, t)) setTimeout(() => { const o = decode(r[t]); if (o !== undefined) em.emit("message", t, o); }, 0); },
    unsubscribe(f) { subs.delete(f); },
    on: em.on, off: em.off,
    end() { ch.close(); },
  };
  if (will) addEventListener("pagehide", () => bus.publish(will.topic, will.payload, true));
  setTimeout(() => em.emit("status", "online"), 0);
  return bus;
}

// ---------------- MQTT transport (live site) ----------------
const MQTT_CDNS = [
  "https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js",
  "https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js",
];
let libPromise = null;
function loadMqttLib() {
  if (globalThis.mqtt) return Promise.resolve(globalThis.mqtt);
  if (libPromise) return libPromise;
  libPromise = (async () => {
    for (const src of MQTT_CDNS) {
      try {
        await new Promise((ok, bad) => {
          const s = document.createElement("script");
          s.src = src; s.async = true; s.onload = ok; s.onerror = bad;
          document.head.appendChild(s);
        });
        if (globalThis.mqtt) return globalThis.mqtt;
      } catch { /* try next CDN */ }
    }
    libPromise = null;
    throw new Error("Could not load the network library. Check your connection and reload.");
  })();
  return libPromise;
}

let preferredBroker = null; // once one broker works, every later connection in this tab uses it

async function tryBroker(lib, url, will, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = lib.connect(url, {
      clientId: "dl_" + randomId(12), clean: true, keepalive: 30, reconnectPeriod: 0,
      connectTimeout: timeoutMs, protocolVersion: 4,
      will: will ? { topic: will.topic, payload: JSON.stringify(will.payload), retain: true, qos: 1 } : undefined,
    });
    const fail = (e) => { try { client.end(true); } catch {} reject(e || new Error("connect failed")); };
    const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs + 500);
    client.once("connect", () => { clearTimeout(timer); client.removeAllListeners("error"); resolve(client); });
    client.once("error", (e) => { clearTimeout(timer); fail(e); });
  });
}

export async function connectMqtt({ will } = {}) {
  const lib = await loadMqttLib();
  const order = preferredBroker ? [preferredBroker, ...BROKERS.filter((b) => b !== preferredBroker)] : BROKERS;
  let client = null, url = null, lastErr = null;
  for (const b of order) {
    try { client = await tryBroker(lib, b, will, 7000); url = b; break; } catch (e) { lastErr = e; }
  }
  if (!client) throw new Error("Could not reach the game network. Check your connection and try again. (" + (lastErr && lastErr.message) + ")");
  preferredBroker = url;
  client.options.reconnectPeriod = 2000; // from now on, reconnect automatically

  const em = emitter(), subs = new Set();
  client.on("message", (topic, payload) => {
    const o = decode(payload ? payload.toString() : "");
    if (o !== undefined) em.emit("message", topic, o);
  });
  client.on("connect", () => { for (const f of subs) client.subscribe(f, { qos: 1 }); em.emit("status", "online"); });
  client.on("reconnect", () => em.emit("status", "reconnecting"));
  client.on("offline", () => em.emit("status", "offline"));
  client.on("error", () => {});
  setTimeout(() => em.emit("status", "online"), 0);
  return {
    id: randomId(), broker: url.replace(/^wss:\/\//, "").replace(/[:/].*$/, ""),
    publish(topic, obj, retain = false) { client.publish(topic, obj == null ? "" : JSON.stringify(obj), { qos: 1, retain }); },
    subscribe(f) { subs.add(f); client.subscribe(f, { qos: 1 }); },
    unsubscribe(f) { subs.delete(f); client.unsubscribe(f); },
    on: em.on, off: em.off,
    end() { try { client.end(true); } catch {} },
  };
}

export function connectBus(kind, opts) {
  return kind === "local" ? Promise.resolve(connectLocal(opts)) : connectMqtt(opts);
}
