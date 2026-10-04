#!/usr/bin/env node
// Mailhub 연결용 Cloudflare 설정 도구.
// connector를 배포한 뒤, 도메인의 메일 수신(Email Routing)과 발송(Email Sending)을 connector에 맞게 설정합니다.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//   node scripts/setup.mjs --domain example.com --verify "mailhub-verify=…"          (바꿀 내용만 보여 줌)
//   node scripts/setup.mjs --domain example.com --verify "mailhub-verify=…" --apply  (실행)
//
// 옵션
//   --domain   연결할 도메인 (Cloudflare zone)
//   --verify   Mailhub가 준 확인용 TXT 값 (POST /api/tenant/domains 응답의 verification.value)
//   --worker   connector Worker 이름 (기본 mailhub-connector)
//   --apply    실제로 바꿈. 없으면 계획만 출력
//   --force    SPF에 Cloudflare가 아닌 발송처가 있어도 진행 (그 발송처의 메일이 스팸 처리될 수 있음)
//
// 하는 일 (이미 된 것은 건너뜀)
//   1. Cloudflare가 아닌 루트 MX와, Cloudflare용이 아닌 SPF 삭제
//   2. Email Routing 켜기 (Cloudflare MX, SPF, DKIM 추가)
//   3. catch-all 규칙 → connector Worker (wrangler 명령으로는 Worker를 지정할 수 없어 API로 함)
//   4. Email Sending 등록 (DKIM, cf-bounce 하위 도메인, DMARC)
//   5. 확인용 TXT 레코드 _mailhub.<도메인>
// 끝나면 Mailhub에 보낼 연결 확인 요청(POST /api/tenant/domains/{domain}/verify)의 본문을 출력합니다.

const API = "https://api.cloudflare.com/client/v4";
const CF_SPF = "v=spf1 include:_spf.mx.cloudflare.net ~all";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);
const domain = opt("domain")?.trim().toLowerCase().replace(/\.$/, "");
const verify = opt("verify")?.trim();
const worker = opt("worker") ?? "mailhub-connector";
const apply = flag("apply");
const force = flag("force");
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

function fail(msg) { console.error(`\n✕ ${msg}`); process.exit(1); }
if (!domain) fail("--domain이 필요합니다.");
if (!verify || !/^mailhub-verify=\S+$/.test(verify)) fail('--verify "mailhub-verify=…"가 필요합니다 (Mailhub의 POST /api/tenant/domains 응답).');
if (!token || !accountId) fail("환경 변수 CLOUDFLARE_API_TOKEN과 CLOUDFLARE_ACCOUNT_ID가 필요합니다.");

async function cf(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const e = data?.errors?.[0];
    const err = new Error(`${method} ${path} → ${res.status} ${e?.message ?? ""}${e?.code ? ` (${e.code})` : ""}`);
    err.status = res.status;
    throw err;
  }
  return data.result;
}
const unquote = (s) => s.replace(/"\s*"/g, "").replace(/^"|"$/g, "");
const isCfMx = (h) => /\.mx\.cloudflare\.net\.?$/i.test(h);
const isSpf = (r) => /^v=spf1(\s|$)/i.test(unquote(r.content));
const spfOthers = (spf) => unquote(spf).split(/\s+/).slice(1)
  .filter((m) => m && !/^[~?+-]?all$/i.test(m) && !/^[~?+-]?include:\S*cloudflare\.(net|com)$/i.test(m));
const denied = (e) => e.status === 401 || e.status === 403;
const hint = (perm) => (e) => { if (denied(e)) fail(`권한이 없습니다: ${perm}\n  ${e.message}`); throw e; };

// ── 점검 (읽기만) ──
console.log(`Mailhub 연결 설정: ${domain} (계정 ${accountId})${apply ? "" : " — 계획만 출력, 실행하려면 --apply"}\n`);
const zones = await cf("GET", `/zones?name=${encodeURIComponent(domain)}&account.id=${accountId}`).catch(hint("Zone: Read"));
const zone = zones[0];
if (!zone) fail(`이 계정에 ${domain} zone이 없습니다 (또는 토큰에 이 zone 권한이 없음).`);
if (zone.status !== "active") fail(`zone 상태가 ${zone.status}입니다. 네임서버를 Cloudflare로 바꾼 뒤 다시 실행하세요.`);
const z = zone.id;

const scripts = await cf("GET", `/accounts/${accountId}/workers/scripts`).catch(hint("Workers Scripts: Edit"));
if (!scripts.some((s) => s.id === worker)) fail(`connector Worker(${worker})가 이 계정에 없습니다. 먼저 npx wrangler deploy로 배포하세요.`);
const subdomain = await cf("GET", `/accounts/${accountId}/workers/subdomain`).then((r) => r.subdomain).catch(() => null);

const records = (type, name) => cf("GET", `/zones/${z}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=100`).catch(hint("DNS: Edit"));
const [mx, txt, verifyTxt] = await Promise.all([records("MX", domain), records("TXT", domain), records("TXT", `_mailhub.${domain}`)]);
const routing = await cf("GET", `/zones/${z}/email/routing`).catch((e) => { if (denied(e)) hint("Email Routing Rules: Edit")(e); return { enabled: false }; });
const catchAll = await cf("GET", `/zones/${z}/email/routing/rules/catch_all`).catch((e) => { if (denied(e)) hint("Email Routing Rules: Edit")(e); return null; });
const rules = await cf("GET", `/zones/${z}/email/routing/rules?per_page=50`).catch(() => []);
const sending = await cf("GET", `/zones/${z}/email/sending/subdomains`).catch(hint("Email Sending: Edit"));

const foreignMx = mx.filter((r) => !isCfMx(r.content));
const spf = txt.filter(isSpf);
const others = [...new Set(spf.flatMap((r) => spfOthers(r.content)))];
const staleSpf = spf.filter((r) => unquote(r.content) !== CF_SPF);
const catchAllOk = catchAll?.enabled && catchAll.actions?.some((a) => a.type === "worker" && a.value?.includes(worker));
const addressRules = rules.filter((r) => r.enabled && !r.matchers?.some((m) => m.type === "all"));
const registered = sending.some((s) => s.name === domain);
const verifyOk = verifyTxt.some((r) => unquote(r.content) === verify);
const staleVerify = verifyTxt.filter((r) => /^mailhub-verify=/.test(unquote(r.content)) && unquote(r.content) !== verify);

const steps = [];
for (const r of foreignMx) steps.push({ text: `MX 삭제: ${r.priority ?? ""} ${r.content}`, run: () => cf("DELETE", `/zones/${z}/dns_records/${r.id}`) });
for (const r of staleSpf) steps.push({ text: `SPF 삭제: ${unquote(r.content)}`, run: () => cf("DELETE", `/zones/${z}/dns_records/${r.id}`) });
if (!routing.enabled) steps.push({ text: "Email Routing 켜기 (Cloudflare MX, SPF, DKIM 추가)", run: () => cf("POST", `/zones/${z}/email/routing/enable`, {}) });
steps.push({
  text: `SPF 확인 (없으면 추가: ${CF_SPF})`, quiet: !staleSpf.length && spf.length === 1,
  run: async () => {
    const now = (await records("TXT", domain)).filter(isSpf);
    if (!now.some((r) => unquote(r.content) === CF_SPF)) await cf("POST", `/zones/${z}/dns_records`, { type: "TXT", name: domain, content: `"${CF_SPF}"`, ttl: 1 });
  },
});
if (!catchAllOk) steps.push({
  text: `catch-all → Worker ${worker}`,
  run: () => cf("PUT", `/zones/${z}/email/routing/rules/catch_all`, { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [worker] }] }),
});
if (!registered) steps.push({ text: "Email Sending 등록 (DKIM, cf-bounce, DMARC)", run: () => cf("POST", `/zones/${z}/email/sending/subdomains`, { name: domain }) });
for (const r of staleVerify) steps.push({ text: `예전 확인용 TXT 삭제: ${unquote(r.content)}`, run: () => cf("DELETE", `/zones/${z}/dns_records/${r.id}`) });
if (!verifyOk) steps.push({ text: `확인용 TXT 추가: _mailhub.${domain} "${verify}"`, run: () => cf("POST", `/zones/${z}/dns_records`, { type: "TXT", name: `_mailhub.${domain}`, content: `"${verify}"`, ttl: 1 }) });

console.log("지금 상태");
console.log(`  MX: ${mx.map((r) => r.content).join(", ") || "없음"}`);
console.log(`  SPF: ${spf.map((r) => unquote(r.content)).join(" / ") || "없음"}`);
console.log(`  Email Routing: ${routing.enabled ? "켜짐" : "꺼짐"}, catch-all: ${catchAllOk ? `Worker ${worker}` : catchAll?.enabled ? "다른 동작" : "꺼짐"}`);
console.log(`  Email Sending: ${registered ? "등록됨" : "등록 안 됨"}, 확인용 TXT: ${verifyOk ? "있음" : "없음"}`);
if (foreignMx.length) console.log(`\n! 다른 메일 서비스의 MX가 있습니다. 진행하면 그쪽으로는 메일이 가지 않습니다.`);
if (addressRules.length) console.log(`! 주소별 라우팅 규칙 ${addressRules.length}개는 catch-all보다 먼저 적용되어 그 주소의 메일은 Mailhub로 가지 않습니다. 필요 없으면 대시보드에서 지우세요.`);
if (others.length) {
  console.log(`! SPF에 Cloudflare가 아닌 발송처가 있습니다: ${others.join(" ")}`);
  console.log(`  이 도메인 이름으로 메일을 보내는 다른 서비스가 있다면 진행 후 그 메일이 스팸 처리될 수 있습니다.`);
  if (!force) fail("확인했다면 --force를 붙여 다시 실행하세요.");
}

const todo = steps.filter((s) => !s.quiet);
console.log(`\n바꿀 내용${todo.length ? "" : ": 없음 (이미 설정됨)"}`);
todo.forEach((s, i) => console.log(`  ${i + 1}. ${s.text}`));

if (apply) {
  console.log("");
  for (const s of steps) {
    process.stdout.write(`… ${s.text}`);
    try { await s.run(); console.log("  ✓"); } catch (e) { console.log(""); fail(e.message); }
  }
  console.log("\n완료. 규칙 반영에 약 1분, DNS 반영에 몇 분 걸릴 수 있습니다.");
}

const sendUrl = subdomain ? `https://${worker}.${subdomain}.workers.dev/send` : null;
console.log("\n다음: Mailhub에 연결 확인 요청");
console.log(`  POST https://api.mailhub.kr/api/tenant/domains/${domain}/verify`);
console.log(`  ${JSON.stringify({ cf_account_id: accountId, send_url: sendUrl ?? "https://<worker>.<하위 도메인>.workers.dev/send" })}`);
if (!sendUrl) console.log("  (이 계정에 workers.dev 하위 도메인이 없습니다. 대시보드 Workers & Pages에서 만들거나 wrangler deploy가 안내하는 대로 만드세요.)");
if (!apply && todo.length) console.log("\n이 계획대로 바꾸려면 --apply를 붙여 다시 실행하세요.");
