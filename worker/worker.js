/**
 * b3.gg — URL shortener on Cloudflare Workers + KV
 *
 * Маршрутизация (route: b3.gg/*):
 *   POST /api/shorten   -> создать короткую ссылку  { url } -> { code, short }
 *   GET  /api/stats     -> сводка по базе
 *   GET  /<code>        -> 302-редирект на длинный URL (если код есть в KV)
 *   всё остальное       -> проксируется на GitHub Pages (origin)
 *
 * Логика кодов:
 *   слоты 0..POOL-1, индекс -> код через биективную base-62.
 *   сначала 1-символьные коды, потом 2-символьные.
 *   пул исчерпан -> переиспользуем слоты по кругу (FIFO, слот 0 — самый старый).
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const K = ALPHABET.length;          // 62
const MAX_LEN = 2;                  // максимальная длина кода
const POOL = K + K * K;             // 62 + 3844 = 3906 слотов

// origin для главного сайта. Контент b3 живёт в репо s11158/b3, но apex-репо
// s11158.github.io привязан к домену tlnt.ae, поэтому канонический адрес —
// tlnt.ae/b3 (github.io/b3 редиректит сюда). Берём напрямую, без редиректа.
const ORIGIN = "https://tlnt.ae/b3";

// пути, которые НИКОГДА не считаются кодом (всегда идут на сайт/в API)
const RESERVED = new Set([
  "", "api", "short", "stats", "favicon.ico", "robots.txt",
  "index.html", "sitemap.xml", "404.html",
]);

const RATE_LIMIT_PER_DAY = 50;      // лимит создания ссылок на один IP в сутки
const MAX_URL_LEN = 2048;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = decodeURIComponent(url.pathname.replace(/^\/+/, "")); // без ведущего "/"

    // www -> apex
    if (host.startsWith("www.")) {
      url.hostname = host.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    // --- API ---
    if (path === "api/shorten" && request.method === "POST") {
      return handleShorten(request, env, url.origin);
    }
    if (path === "api/stats" && request.method === "GET") {
      return handleStats(env);
    }

    // --- редирект по коду ---
    // код = одиночный сегмент пути (без "/"), длиной 1..MAX_LEN, не из RESERVED
    if (
      request.method === "GET" &&
      !RESERVED.has(path) &&
      !path.includes("/") &&
      path.length >= 1 &&
      path.length <= MAX_LEN &&
      isCode(path)
    ) {
      const rec = await env.LINKS.get("c:" + path);
      if (rec) {
        const { url: target } = JSON.parse(rec);
        // 302 — временный, т.к. коды переиспользуются (нельзя кэшировать навсегда)
        return new Response(null, {
          status: 302,
          headers: { Location: target, "Cache-Control": "no-store" },
        });
      }
    }

    // --- всё остальное проксируем на GitHub Pages ---
    return proxyToOrigin(request, url);
  },
};

/* ---------------- API: создание ссылки ---------------- */

async function handleShorten(request, env, selfOrigin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  let target = (body.url || "").trim();
  if (!target) return json({ error: "empty" }, 400);
  if (target.length > MAX_URL_LEN) return json({ error: "too_long" }, 400);

  // нет схемы -> добавим https
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "invalid_url" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ error: "bad_scheme" }, 400);
  }
  // запрет ссылок на сам сервис (петли)
  if (parsed.hostname === "b3.gg" || parsed.hostname.endsWith(".b3.gg")) {
    return json({ error: "self_link" }, 400);
  }

  // лимит по IP
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `rl:${ip}:${day}`;
  const used = parseInt((await env.LINKS.get(rlKey)) || "0", 10);
  if (used >= RATE_LIMIT_PER_DAY) {
    return json({ error: "rate_limited" }, 429);
  }

  const code = await allocate(env, parsed.toString());
  await env.LINKS.put(rlKey, String(used + 1), { expirationTtl: 86400 });

  return json({
    code,
    short: `${selfOrigin}/${code}`,
    url: parsed.toString(),
  });
}

/* ---------------- API: статистика ---------------- */

async function handleStats(env) {
  const meta = await readMeta(env);
  const phase = meta.count < POOL ? "forward" : "recycling";
  return json({
    issued: meta.count,
    pool: POOL,
    phase,
    next_recycle_slot: phase === "recycling" ? meta.next : null,
    max_len: MAX_LEN,
    alphabet_size: K,
  });
}

/* ---------------- аллокация кода ---------------- */

async function allocate(env, target) {
  // дедуп: уже сокращали этот URL?
  const uk = "u:" + (await sha(target));
  const existing = await env.LINKS.get(uk);
  if (existing) return existing;

  const meta = await readMeta(env);
  let idx, code;

  if (meta.count < POOL) {
    // прямая фаза: заполняем слоты по порядку
    idx = meta.count;
    code = nextFreeCode(idx, "forward");
    meta.count += 1;
  } else {
    // фаза переработки: берём самый старый слот по кругу
    idx = meta.next;
    code = nextFreeCode(idx, "recycle");
    meta.next = (meta.next + 1) % POOL;
    // освобождаем старую дедуп-запись переиспользуемого кода
    const old = await env.LINKS.get("c:" + code);
    if (old) {
      try {
        const oldObj = JSON.parse(old);
        await env.LINKS.delete("u:" + (await sha(oldObj.url)));
      } catch { /* ignore */ }
    }
  }

  await env.LINKS.put("c:" + code, JSON.stringify({ url: target, created: Date.now() }));
  await env.LINKS.put(uk, code);
  await writeMeta(env, meta);
  return code;
}

// если код попал в RESERVED — берём следующий слот того же круга
function nextFreeCode(idx, mode) {
  for (let step = 0; step < POOL; step++) {
    const i = mode === "forward" ? idx + step : (idx + step) % POOL;
    const code = indexToCode(i);
    if (!RESERVED.has(code)) return code;
  }
  return indexToCode(idx); // теоретически недостижимо
}

/* ---------------- кодек индекс <-> код ---------------- */

function indexToCode(i) {
  if (i < K) return ALPHABET[i];            // 1-символьные
  const j = i - K;                          // 2-символьные
  return ALPHABET[Math.floor(j / K)] + ALPHABET[j % K];
}

function isCode(s) {
  for (const ch of s) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/* ---------------- meta в KV ---------------- */

async function readMeta(env) {
  const raw = await env.LINKS.get("meta");
  return raw ? JSON.parse(raw) : { count: 0, next: 0 };
}
function writeMeta(env, meta) {
  return env.LINKS.put("meta", JSON.stringify(meta));
}

/* ---------------- прокси на GitHub Pages ---------------- */

async function proxyToOrigin(request, url) {
  const originUrl = ORIGIN + url.pathname + url.search;
  const resp = await fetch(originUrl, {
    method: request.method,
    headers: request.headers,
    redirect: "manual",
  });
  // отдаём как есть
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

/* ---------------- утилиты ---------------- */

async function sha(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
