// main.ts - Deno Deploy 版代理伺服器 (v3 - 轉發模式優化)

// ... (前面的 PROXY_USERNAME, PROXY_PASSWORD, checkAuth, proxyAuthenticationRequired 都不變) ...

const PROXY_USERNAME = Deno.env.get("PROXY_USERNAME") || "";
const PROXY_PASSWORD = Deno.env.get("PROXY_PASSWORD") || "";

function checkAuth(proxyAuthHeader: string | null): boolean {
  if (!PROXY_USERNAME || !PROXY_PASSWORD) return true;
  if (!proxyAuthHeader || !proxyAuthHeader.startsWith("Basic ")) return false;
  try {
    const decoded = atob(proxyAuthHeader.replace("Basic ", ""));
    const [user, pass] = decoded.split(":");
    return user === PROXY_USERNAME && pass === PROXY_PASSWORD;
  } catch (e) {
    return false;
  }
}

function proxyAuthenticationRequired(): Response {
  return new Response(JSON.stringify({ message: "Proxy authentication required!" }), {
    status: 407,
    headers: { "Proxy-Authenticate": 'Basic realm="Login Required"', "Content-Type": "application/json" },
  });
}

function filterHeaders(headers: Headers): Headers {
    const newHeaders = new Headers();
    for (const [k, v] of headers.entries()) {
        const lower = k.toLowerCase();
        if (["host", "content-length", "transfer-encoding", "connection", "proxy-authorization"].includes(lower)) {
            continue;
        }
        newHeaders.set(k, v);
    }
    return newHeaders;
}

// Proxy handler
async function handleProxy(req: Request): Promise<Response> {
  // 認證檢查保持不變
  if (!checkAuth(req.headers.get("proxy-authorization"))) {
    return proxyAuthenticationRequired();
  }

  // --- [修改] ---
  // 核心修改：不再嘗試建立隧道，而是直接轉發請求
  const urlObj = new URL(req.url);
  let targetUrl = urlObj.searchParams.get("url");

  // 如果是 POST 請求，才嘗試從 body 讀取 url
  if (!targetUrl && req.method === "POST" && req.headers.get("content-type")?.includes("application/json")) {
    try {
      const bodyJson = await req.json();
      if (bodyJson.url) {
        targetUrl = bodyJson.url;
      }
    } catch { /* ignore parse error */ }
  }
  // --- [修改結束] ---

  if (!targetUrl) {
    return new Response(
      JSON.stringify({ error: "Missing 'url' parameter in query." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const filteredHeaders = filterHeaders(req.headers);
    const upstreamResp = await fetch(targetUrl, {
      method: req.method,
      headers: filteredHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      // @ts-ignore
      duplex: 'half'
    });
    const respHeaders = new Headers(upstreamResp.headers);
    // 移除不應轉發的 hop-by-hop headers
    ["content-encoding", "content-length", "transfer-encoding", "connection"].forEach(h => respHeaders.delete(h));
    
    return new Response(upstreamResp.body, { status: upstreamResp.status, headers: respHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Proxy request failed: ${err.message}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

// Server 啟動邏輯保持不變
Deno.serve(async (req: Request) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/") return new Response("Deno Proxy is running");
  if (pathname === "/proxy") return await handleProxy(req);
  return new Response("Not Found", { status: 404 });
});
