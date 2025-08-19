// main.ts - Deno Deploy 版代理伺服器 (v2 - 標準代理認證)

// 讀取環境變數
const PROXY_USERNAME = Deno.env.get("PROXY_USERNAME") || "";
const PROXY_PASSWORD = Deno.env.get("PROXY_PASSWORD") || "";

// [修改 1] 檢查 "Proxy-Authorization" 標頭
function checkAuth(proxyAuthHeader: string | null): boolean {
  // 如果沒有設定使用者名稱或密碼，則不進行驗證，直接通過
  if (!PROXY_USERNAME || !PROXY_PASSWORD) {
    return true;
  }
  
  if (!proxyAuthHeader || !proxyAuthHeader.startsWith("Basic ")) {
    return false;
  }
  const base64 = proxyAuthHeader.replace("Basic ", "");
  try {
    const decoded = atob(base64);
    const [user, pass] = decoded.split(":");
    return user === PROXY_USERNAME && pass === PROXY_PASSWORD;
  } catch (e) {
    console.error("Base64 decoding failed:", e);
    return false;
  }
}

// [修改 2] 建立 407 Proxy Authentication Required 回應
function proxyAuthenticationRequired(): Response {
  return new Response(
    JSON.stringify({ message: "Proxy authentication required!" }),
    {
      status: 407, // <-- 狀態碼改為 407
      headers: {
        // <-- 標頭改為 Proxy-Authenticate
        "Proxy-Authenticate": 'Basic realm="Login Required"',
        "Content-Type": "application/json",
      },
    },
  );
}

// 過濾掉不應轉發的 headers
function filterHeaders(headers: Headers): Headers {
  const newHeaders = new Headers();
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    // 代理認證的標頭不應該被轉發到目標伺服器
    if (
      [
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "proxy-authorization", // <-- 新增過濾
      ].includes(lower)
    ) {
      continue;
    }
    newHeaders.set(k, v);
  }
  return newHeaders;
}

// Proxy handler
async function handleProxy(req: Request): Promise<Response> {
  // [修改 3] 認證檢查，改為讀取 "proxy-authorization" 標頭
  if (!checkAuth(req.headers.get("proxy-authorization"))) {
    return proxyAuthenticationRequired(); // <-- 呼叫新的 407 回應函式
  }

  // 取得目標 URL
  const urlObj = new URL(req.url);
  let targetUrl = urlObj.searchParams.get("url");

  if (!targetUrl && req.headers.get("content-type")?.includes("application/json")) {
    try {
      const bodyJson = await req.json();
      if (bodyJson.url) {
        targetUrl = bodyJson.url;
      }
    } catch {
      // ignore parse error
    }
  }

  if (!targetUrl) {
    return new Response(
      JSON.stringify({ error: "Missing 'url' parameter in query or JSON body." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const filteredHeaders = filterHeaders(req.headers);

    const upstreamResp = await fetch(targetUrl, {
      method: req.method,
      headers: filteredHeaders,
      body: req.method !== "GET" && req.method !== "HEAD"
        ? req.body
        : undefined,
      // Deno Deploy 上的 fetch 支援 duplex
      // @ts-ignore: Deno Deploy supports duplex
      duplex: 'half' 
    });

    // 過濾掉不應回傳的 headers
    const respHeaders = new Headers();
    upstreamResp.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (
        ["content-encoding", "content-length", "transfer-encoding", "connection"]
          .includes(lower)
      ) {
        return;
      }
      respHeaders.set(k, v);
    });

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Proxy request failed: ${err.message}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

// 啟動 Deno HTTP Server
Deno.serve(async (req: Request) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/") {
    return new Response("Deno Proxy is running");
  } else if (pathname === "/proxy") {
    return await handleProxy(req);
  } else {
    return new Response("Not Found", { status: 404 });
  }
});
