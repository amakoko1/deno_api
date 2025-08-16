// main.ts - Deno Deploy 版代理伺服器

// 讀取環境變數
const PROXY_USERNAME = Deno.env.get("PROXY_USERNAME") || "";
const PROXY_PASSWORD = Deno.env.get("PROXY_PASSWORD") || "";

// 檢查認證
function checkAuth(authHeader: string | null): boolean {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return false;
  }
  const base64 = authHeader.replace("Basic ", "");
  const decoded = atob(base64);
  const [user, pass] = decoded.split(":");
  return user === PROXY_USERNAME && pass === PROXY_PASSWORD;
}

// 建立 401 認證挑戰回應
function unauthorized(): Response {
  return new Response(
    JSON.stringify({ message: "Authentication required!" }),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Login Required"',
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
    if (
      ["host", "content-length", "transfer-encoding", "connection"].includes(
        lower,
      )
    ) {
      continue;
    }
    newHeaders.set(k, v);
  }
  return newHeaders;
}

// Proxy handler
async function handleProxy(req: Request): Promise<Response> {
  // 認證檢查
  if (!checkAuth(req.headers.get("authorization"))) {
    return unauthorized();
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

  let upstreamResp: Response;
  try {
    const filteredHeaders = filterHeaders(req.headers);

    upstreamResp = await fetch(targetUrl, {
      method: req.method,
      headers: filteredHeaders,
      body: req.method !== "GET" && req.method !== "HEAD"
        ? await req.arrayBuffer()
        : undefined,
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
