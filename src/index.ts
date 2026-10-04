// Cloudflare 계정마다 하나씩 두는 mailhub의 연결 Worker.
//
// 수신: Email Routing catch-all이 넘긴 메일을 core의 /hooks/ingest로 원문 그대로 전달한다.
//   core 응답이 200이면 받음, 422면 core가 준 사유로 영구 거부(보낸 쪽에 555),
//   그 밖에는 예외를 던져 일시 실패(421)로 돌린다. 보낸 서버가 나중에 다시 보내므로 따로 보관하지 않는다.
//
// 발송: core와 다른 계정에서만 쓴다. core가 POST /send로 맡긴 메일을 이 계정의 send_email 바인딩으로 보낸다.
//   도메인의 발송 등록(Email Sending)이 이 계정에 있으므로, core는 Cloudflare API 토큰 없이 발송할 수 있다.
//
// 옮겨 간 주소: 예전 메일 시스템의 웹·API 주소처럼 이 계정 zone에 남은 주소를 새 주소로 넘긴다 (MOVED_HOSTS).
//
// 확인: GET /health (토큰 필요). Mailhub가 연결을 확인할 때 토큰이 맞는지, 발송 바인딩이 있는지 본다.

interface Env {
  /** core가 같은 계정에 있으면 서비스 바인딩 (없으면 INGEST_URL로 인터넷을 거쳐 보냄) */
  CORE?: Fetcher;
  /** 이 계정 도메인의 발송. core와 같은 계정이면 두지 않음 (core가 직접 보냄) */
  EMAIL?: SendEmail;
  INGEST_URL: string;
  /** core와 이 Worker가 서로를 확인하는 토큰. 수신 때는 core에 보내고, 발송 때는 core에서 받음 */
  CONNECTOR_TOKEN: string;
  /** 호스트 → 새 주소 (예: { "mail.aigent.kr": "https://app.mailhub.kr" }). 경로와 쿼리는 그대로 붙임 */
  MOVED_HOSTS?: Record<string, string>;
}

// core가 이 시간 안에 답하지 않으면 일시 실패로 돌림
const TIMEOUT_MS = 60_000;
/** connector 코드 판. 고치면 올림 (Mailhub가 /health로 어느 판이 올라가 있는지 봄) */
const VERSION = "2026-10-04";

function sameToken(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    // 헤더 값에는 ASCII만 넣을 수 있으므로 인코딩해서 보냄 (core에서 decodeURIComponent)
    const enc = (v: string | null) => encodeURIComponent(v ?? "");
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CONNECTOR_TOKEN}`,
        "Content-Type": "message/rfc822",
        "X-Envelope-From": enc(message.from),
        "X-Envelope-To": enc(message.to),
        "X-Auth-Results": enc(message.headers.get("authentication-results")),
        "X-Arc-Auth-Results": enc(message.headers.get("arc-authentication-results")),
      },
      body: raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    const res = env.CORE ? await env.CORE.fetch(env.INGEST_URL, init) : await fetch(env.INGEST_URL, init);
    if (res.ok) return;
    if (res.status === 422) {
      const { reject } = await res.json<{ reject?: string }>().catch(() => ({ reject: undefined }));
      console.log("rejected", message.to, reject);
      return message.setReject(reject || "Rejected");
    }
    throw new Error(`ingest failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  },

  async fetch(req, env) {
    const { hostname, pathname, search } = new URL(req.url);
    const moved = env.MOVED_HOSTS?.[hostname];
    // GET은 301, 그 밖의 요청은 메서드와 본문이 유지되는 308
    if (moved) return Response.redirect(moved + pathname + search, req.method === "GET" || req.method === "HEAD" ? 301 : 308);
    const health = req.method === "GET" && pathname === "/health";
    if (!health && (req.method !== "POST" || pathname !== "/send" || !env.EMAIL)) return new Response("Not found", { status: 404 });
    const m = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "");
    if (!m || !sameToken(m[1], env.CONNECTOR_TOKEN)) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    if (health) return Response.json({ ok: true, version: VERSION, send: !!env.EMAIL });
    if (!env.EMAIL) return new Response("Not found", { status: 404 });
    // 메시지 형식은 send_email 바인딩 그대로. 누가 어떤 주소로 보낼 수 있는지는 core가 이미 확인함
    const msg = await req.json<Parameters<SendEmail["send"]>[0]>();
    try {
      const r = await env.EMAIL.send(msg);
      return Response.json({ messageId: r.messageId });
    } catch (e: any) {
      console.error("send failed", e.code, e.message);
      return Response.json({ error: { code: e.code ?? "send_failed", message: e.message } }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
