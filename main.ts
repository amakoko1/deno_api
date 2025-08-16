// main.ts - Recommended version for Deno Deploy

// --- Configuration ---
// Using Deno.env.get for flexible configuration. Best practice for deployment.
const API_KEY = Deno.env.get("PROXY_API_KEY") || "";
const MAX_REQS_PER_MINUTE = Number(Deno.env.get("MAX_REQS_PER_MINUTE") || "30");

const requestsLog: Record<string, number[]> = {};

// Helper: Rate limiting
function checkRateLimit(key: string) {
  const now = Date.now();
  if (!requestsLog[key]) requestsLog[key] = [];
  requestsLog[key] = requestsLog[key].filter(ts => now - ts < 60_000);
  if (requestsLog[key].length >= MAX_REQS_PER_MINUTE) {
    return false;
  }
  requestsLog[key].push(now);
  return true;
}

// SSRF basic protection
function isPrivateHost(url: URL): boolean {
  return ["localhost", "127.0.0.1"].includes(url.hostname);
}

// Proxy handler
async function handleProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = url.searchParams.get("url");

  // API Key check
  const clientKey = req.headers.get("x-api-key");
  if (!API_KEY || clientKey !== API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid URL" }), { status: 400 });
  }

  if (isPrivateHost(targetUrl)) {
    return new Response(JSON.stringify({ error: "Blocked private host" }), { status: 403 });
  }

  // Rate limiting
  if (!checkRateLimit(clientKey)) {
    return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.method !== "GET" ? await req.arrayBuffer() : undefined,
    });

    const respHeaders = new Headers(upstream.headers);
    respHeaders.set("x-proxy-by", "deno-deploy");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}

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
