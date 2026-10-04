# mailhub-connector

[Mailhub](https://api.mailhub.kr/api/docs.md)에 도메인을 연결하기 위한 Cloudflare Worker와 설정 도구입니다.

Cloudflare의 메일 수신(Email Routing)과 발송(Email Sending)은 **도메인이 있는 Cloudflare 계정 안의 Worker만** 쓸 수 있습니다. 그래서 도메인이 있는 계정에 이 connector를 배포하고, Mailhub와 connector 토큰으로 서로를 확인합니다.

```
보낸 사람 → (MX) Cloudflare Email Routing → catch-all → connector ─HTTPS→ Mailhub (저장, API, 웹훅)
Mailhub ─HTTPS /send→ connector → 이 계정의 Email Sending → 받는 사람
```

- **Mailhub에 Cloudflare 토큰을 주지 않습니다.** Cloudflare 쪽 작업은 도메인 주인이 직접 하고, 진행 상황은 Mailhub API로 알립니다.
- connector는 메일을 보관하지 않습니다. Mailhub가 일시적으로 받지 못하면 보낸 서버에 일시 실패(4xx)로 돌려 나중에 다시 보내게 합니다.
- connector 토큰은 그 테넌트의 도메인 메일만 넘길 수 있습니다.

## 준비

| 항목 | 내용 |
|---|---|
| 도메인 | Cloudflare에 zone으로 있어야 함 (네임서버가 Cloudflare) |
| 요금제 | 그 계정이 **Workers Paid** (Email Sending은 무료 요금제에서 쓸 수 없음) |
| Mailhub 토큰 | Mailhub 운영자가 준 **테넌트 관리자 토큰** `mh_tn_…` |
| Cloudflare 토큰 | 아래 권한의 API 토큰 (Manage Account → API Tokens, 계정 소유 토큰 권장) |
| 도구 | Node.js 18 이상 |

Cloudflare 토큰 권한:

| 범위 | 권한 |
|---|---|
| Account | Workers Scripts: Edit, Email Sending: Edit, Account Settings: Read |
| Zone (연결할 도메인) | Email Routing Rules: Edit, Zone Settings: Edit, DNS: Edit, Zone: Read |

Email Routing Addresses 권한은 필요 없습니다 (다른 주소로 전달할 때만 씀).

## 연결 절차

아래에서 `MH`는 `https://api.mailhub.kr`, `$MAILHUB_TOKEN`은 테넌트 관리자 토큰입니다.

### 1. 도메인 등록 (Mailhub)

운영자가 테넌트를 만들 때 도메인을 넣었다면 이미 등록되어 있습니다. `GET /api/tenant/domains`로 확인하고 2단계로 갑니다.

```bash
curl -s -X POST $MH/api/tenant/domains \
  -H "Authorization: Bearer $MAILHUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"domain":"example.com"}'
```

응답의 `verification.value`(`mailhub-verify=…`)를 3단계에서 씁니다.

### 2. connector 토큰 발급 (Mailhub)

```bash
curl -s -X POST $MH/api/tenant/connectors \
  -H "Authorization: Bearer $MAILHUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"cf_account_id":"<Cloudflare 계정 ID>"}'
```

응답의 `token`(`mhc_…`)은 **한 번만** 보입니다. 바로 다음 단계에서 비밀값으로 넣으세요. 같은 계정으로 다시 발급하면 예전 토큰은 즉시 폐기됩니다.

### 3. connector 배포와 Cloudflare 설정

```bash
git clone https://github.com/aigent-pub/mailhub-connector
cd mailhub-connector
npm install

export CLOUDFLARE_API_TOKEN=<Cloudflare 토큰>
export CLOUDFLARE_ACCOUNT_ID=<Cloudflare 계정 ID>

npx wrangler deploy                      # connector 배포 (workers.dev 주소가 켜짐)
npx wrangler secret put CONNECTOR_TOKEN  # 2단계의 mhc_ 토큰 입력

# 도메인 설정: 먼저 바꿀 내용을 보고, --apply로 실행
npm run setup -- --domain example.com --verify "mailhub-verify=…"
npm run setup -- --domain example.com --verify "mailhub-verify=…" --apply
```

`setup`이 하는 일 (이미 된 것은 건너뜀):

1. Cloudflare가 아닌 루트 MX와, Cloudflare용이 아닌 SPF 삭제
2. Email Routing 켜기 (Cloudflare MX, SPF, DKIM 추가)
3. catch-all 규칙 → connector Worker (wrangler 명령으로는 catch-all에 Worker를 지정할 수 없어 API로 함)
4. Email Sending 등록 (DKIM, `cf-bounce` 하위 도메인, DMARC)
5. 확인용 TXT 레코드 `_mailhub.<도메인>`

SPF에 Cloudflare가 아닌 발송처(`include:` 등)가 있으면 멈춥니다. 그 도메인 이름으로 메일을 보내는 다른 서비스가 있다면 연결 후 그 메일이 스팸 처리될 수 있으니 확인하고 `--force`로 다시 실행하세요. 주소별 라우팅 규칙이 있으면 그 주소의 메일은 catch-all보다 먼저 처리되어 Mailhub로 가지 않으니 대시보드에서 지우세요.

끝나면 다음 단계에 보낼 본문을 출력합니다.

### 4. 연결 확인 요청 (Mailhub)

```bash
curl -s -X POST $MH/api/tenant/domains/example.com/verify \
  -H "Authorization: Bearer $MAILHUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"cf_account_id":"<계정 ID>","send_url":"https://mailhub-connector.<하위 도메인>.workers.dev/send"}'
```

Mailhub가 확인하는 것:

| 항목 | 내용 |
|---|---|
| `verification` | `_mailhub.<도메인>` TXT에 `mailhub-verify=…` |
| `mx` | MX가 모두 Cloudflare Email Routing (`*.mx.cloudflare.net`) |
| `spf` | SPF 레코드가 하나이고 `include:_spf.mx.cloudflare.net` 포함 |
| `connector` | `send_url`의 `/health`가 토큰을 받아들이고 발송 바인딩이 있음 |

모두 통과하면 `status`가 `active`가 되고, 약 1분 뒤부터 메일 계정을 만들고 메일을 받을 수 있습니다. 실패하면 `checks`에서 `ok: false`인 항목의 `detail`대로 고친 뒤 다시 부르세요. DNS는 반영에 몇 분 걸릴 수 있습니다.

### 5. 계정 만들기와 시험

`POST /api/tenant/accounts`로 메일 주소를 만들고, 외부 메일(예: Gmail)에서 보내 수신을 확인한 뒤 발송 API로 답장해 봅니다. catch-all 연결은 바깥에서 확인할 수 없어 이 시험으로 확인합니다. 자세한 API는 Mailhub 연동 매뉴얼과 [API 문서](https://api.mailhub.kr/api/docs.md)를 보세요.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 메일이 안 들어옴 | Email Routing의 catch-all이 `mailhub-connector`를 가리키는지, connector 로그(`npx wrangler tail`)에 오류가 있는지 |
| connector 로그에 `ingest failed: 401` | 토큰이 바뀜. `CONNECTOR_TOKEN`을 마지막으로 발급받은 값으로 |
| connector 로그에 `ingest failed: 403` | 도메인이 이 토큰의 테넌트·계정에 연결되지 않음. 4단계를 다시 확인 |
| 보낸 쪽에 `555 Unknown recipient` | Mailhub에 그 주소의 계정이 없음 (또는 도메인 활성화 후 1분이 안 지남) |
| 발송이 `connector_unreachable` | connector 주소가 바뀌었으면 4단계를 다시 불러 `send_url`을 알림 |
| 발송이 `E_…` 오류 | Cloudflare Email Sending 오류. Workers Paid, Email Sending 등록 상태 확인 |
| `setup`이 권한 오류 | 출력된 권한을 토큰에 추가 |

## connector 토큰 교체

1. 2단계를 다시 불러 새 토큰을 받습니다 (예전 토큰은 즉시 폐기).
2. `npx wrangler secret put CONNECTOR_TOKEN`으로 새 토큰을 넣습니다.

그 사이에 들어온 메일은 connector가 일시 실패로 돌려, 보낸 서버가 나중에 다시 보냅니다.

## connector 갱신

이 저장소를 받아(`git pull`) `npx wrangler deploy`를 다시 실행합니다. 비밀값과 설정은 그대로 유지됩니다.

## 동작

- `email()`: catch-all로 받은 메일을 원문 그대로 `INGEST_URL`에 POST. 응답 200이면 받음, 422면 Mailhub가 준 사유로 영구 거부(보낸 쪽에 555), 그 밖에는 일시 실패(421).
- `POST /send`: Mailhub가 맡긴 메일을 `send_email` 바인딩으로 발송 (토큰 필요).
- `GET /health`: 토큰 확인과 발송 바인딩 여부 (토큰 필요). 그 밖의 경로는 404.
