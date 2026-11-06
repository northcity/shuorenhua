import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = "https://shuorenhua-beicheng.beicbeichbeichengbeicheng.chatgpt.site/api/transform";
const ALLOWED_ORIGINS = new Set([
  "https://shuorenhua.online",
  "https://www.shuorenhua.online",
]);
const MAX_BODY_BYTES = 32 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const rateBuckets = new Map();

function send(res, status, body, origin) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(origin ? {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    } : {}),
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "";
  if (req.method === "OPTIONS") {
    if (!allowedOrigin) return send(res, 403, { success: false, error: { message: "Origin not allowed." } });
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    });
    return res.end();
  }

  if (req.url === "/health" && req.method === "GET") {
    return send(res, 200, { ok: true });
  }
  if (req.url !== "/api/transform" || req.method !== "POST") {
    return send(res, 404, { success: false, error: { message: "Not found." } }, allowedOrigin);
  }
  if (origin && !allowedOrigin) {
    return send(res, 403, { success: false, error: { message: "Origin not allowed." } });
  }

  const now = Date.now();
  const key = req.socket.remoteAddress || "unknown";
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS) {
    return send(res, 429, { success: false, error: { message: "请求过于频繁，请稍后再试。" } }, allowedOrigin);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return send(res, 413, { success: false, error: { message: "请求内容过长。" } }, allowedOrigin);
    }
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(res, 400, { success: false, error: { message: "请求格式无效。" } }, allowedOrigin);
  }
  if (!payload || typeof payload.text !== "string" || !payload.text.trim() || [...payload.text].length > 3000) {
    return send(res, 400, { success: false, error: { message: "请输入 1 到 3000 字的内容。" } }, allowedOrigin);
  }
  if (typeof payload.mode !== "string" || typeof payload.tone !== "string") {
    return send(res, 400, { success: false, error: { message: "处理模式或语气无效。" } }, allowedOrigin);
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ mode: payload.mode, tone: payload.tone, text: payload.text }),
      signal: AbortSignal.timeout(45_000),
    });
    const responseText = await upstream.text();
    let responseBody;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = { success: false, error: { message: "处理服务返回了无效响应。" } };
    }
    return send(res, upstream.status, responseBody, allowedOrigin);
  } catch {
    return send(res, 502, { success: false, error: { message: "处理服务暂时不可用，请稍后重试。" } }, allowedOrigin);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Transform proxy listening on ${PORT}`);
});
