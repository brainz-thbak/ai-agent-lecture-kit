# 설계 정답지 — 첨부 교체 과제

`ai-agent-study` 의 앱을 어떻게 얽어 두었는지, 그래서 "첨부 교체" 요구사항이 어디까지 영향을 주는지 정리한 문서다.
코드 구현, seed, 채점은 이 문서를 기준으로 한다. **에이전트가 보는 저장소에는 이 내용을 두지 않는다.**

## 과제

```text
이벤트 첨부를 새 파일로 교체할 수 있게 해줘.
PUT /incidents/:id/attachment 에 { "name": 파일 이름, "content": 파일 내용 } 을 보내면 첨부가 바뀌고, 200 과 갱신된 이벤트를 돌려준다.
```

숨긴 정책은 없다. 채점은 **교체 후에도 기존 기능이 일관되게 동작하는가**만 본다. 아래 "교체 영향 목록"의 기대 동작은 모두 교체 전부터 시스템이 지키던 동작이다.

## 저장소 구조

```text
app/            백엔드 (Node + TypeScript + SQLite). 두 조건이 같은 앱에서 작업한다
fe/             화면 (React)
file-store/     파일 저장소. 내용 기반 중복 제거
```

## 첨부 개념이 넷으로 갈라진 구조

같은 "이벤트 첨부 파일"을 네 모듈이 각자 다룬다. 넷 모두 같은 파일 저장소 ID 를 가리키지만 이름이 다르다.

| 모듈 | 설정상 배경 | 사용처 | 저장 위치 | 파일 ID 변수 | 이름 변수 | 이벤트 ID 변수 | 조회 함수 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `attachments` | 현재 기본 모듈 | 화면, `v2` API | `incident_attachments` | `fileId` | `attachmentName` | `incidentId` | `getAttachment` |
| `evidence` | 옛 모듈. 주석에 "deprecated, 사용처 없음" | `v1` API, export 작업 | `evidence_items` | `digest` | `evidenceTitle` | `caseNo` | `loadEvidence` |
| `artifacts` | 새 팀이 만들다 멈춘 모듈 | search, preview | 뷰 `artifact_view` (`incident_attachments` 를 읽음) | `objectRef` | `label` | `ownerKey` | `resolveArtifact` |
| `documents` | 보고서 팀 자체 구현 | reports | `reports` 행에 복사 | `docHash` | `docName` | `sourceRef` | `fetchDoc` |

- 첨부를 만들 때 `attachments` 가 `evidence_items` 에도 같은 값을 기록한다 (이중 기록). 교체할 때 `incident_attachments` 만 바꾸면 `v1` 과 export 는 옛 파일을 가리킨다.
- `artifact_view` 는 뷰라서 자동으로 새 값을 보지만, `artifacts` 모듈은 메모리 캐시(`artifactMemo`, 키는 `ownerKey`)를 따로 둔다.
- `documents` 는 보고서를 만들 때 파일 ID 를 복사해 둔다. 보고서는 만든 시점의 증빙을 계속 보여 줘야 한다.

## 나머지 모듈과 결합

| 모듈 | 하는 일 | 어떤 첨부 모듈을 쓰나 | 파일 ID 를 부르는 이름 | 결합 방식 |
| --- | --- | --- | --- | --- |
| `incidents` | 이벤트 등록·처리 | `attachments` | `fileId` | 직접 호출 |
| `reports` | 감사 보고서 | `documents` | `docHash` | 직접 호출 |
| `export` | 증빙 내보내기 작업. 요청 시점의 파일 목록을 `export_jobs.manifest` JSON 에 저장하고, 실행할 때 `v1` 다운로드 경로로 파일을 읽는다 | `evidence` | `blobKey` | JSON 컬럼, 내부 HTTP |
| `search` | 첨부 이름·내용 색인 | `artifacts` | `attachmentHash` | 이벤트 버스 |
| `preview` | 로그 미리보기 캐시 (메모리 + `preview_cache` 테이블) | `artifacts` | `contentKey` | 이벤트 버스, 메모리 캐시 |
| `stats` | 대시보드용 비정규화 카운터 `incident_stats` (첨부 수, 바이트) | — | — | 이벤트 버스 |
| `audit-log` | 작업 기록 | `evidence` | `evidenceRef` | 이벤트 버스 |
| `notifications` | 외부 알림 발송 대기열 `notification_outbox` | `evidence` | `evidenceRef` | 이벤트 버스 |
| `event-bus` | 문자열 토픽. 핸들러는 `config/handlers.json` 에서 모듈 경로와 함수 이름으로 등록 | — | — | 설정 파일, 동적 import |

### 이벤트 토픽

| 토픽 | 발행하는 곳 | 받는 핸들러 | 하는 일 |
| --- | --- | --- | --- |
| `attachment.stored` | `attachments` | `search.indexArtifact`, `stats.bumpAttachment`, `preview.warm`, `auditLog.recordEvidence`, `notifications.enqueueEvidence` | 색인 추가, 첨부 수 +1·바이트 +n, 미리보기 캐시, 기록, 알림 |
| `incident.closed` | `incidents` | `stats.bumpClosed`, `notifications.enqueueClosed` | 카운터, 알림 |
| `report.created` | `reports` | `auditLog.recordReport` | 기록 |
| `export.completed` | `export` | `auditLog.recordExport`, `notifications.enqueueExport` | 기록, 알림 |

교체를 `attachment.stored` 로 처리하면 `stats` 의 첨부 수가 1 늘어난다. 교체 전용 토픽을 만들거나 핸들러가 교체를 구분해야 한다.

## 확장 도메인 — 첨부와 무관해 보이는 네 기능

각 기능은 대부분 독립적으로 동작하고, 첨부 파일 ID 와는 한두 군데에서만 이어진다. 연결점은 모두 실행해야 드러나도록 두었다. 이름은 또 다르게 붙였고 README 에는 적지 않았다.

| 기능 | 위치 (API 세대) | 첨부를 부르는 이름 | 연결점 | 결합 유형 | 교체하면 깨지는 것 |
| --- | --- | --- | --- | --- | --- |
| 접근 권한 공유 | 부여: 레거시 `POST /legacy/share`, 확인·다운로드: v3 `GET /v3/shared/:grantee/:incidentId` | `blobRef` (`share_grants.blob_ref`) | 권한을 이벤트가 아니라 **부여 당시 파일 ID** 로 저장하고, v3 는 이벤트의 현재 파일 ID 로 권한을 찾는다. 행에는 `case_ref` 도 있다 | 같은 값을 다른 테이블에서 공유 | 새 파일에 권한이 없어 공유받은 사람이 403. 반대로 `blob_ref` 기준으로 옮기면 같은 파일을 쓰던 다른 이벤트의 권한까지 바뀐다 |
| 저장 용량 과금 | 집계: 이벤트 버스 `billing.recordUsage`, 조회: v3 `GET /v3/billing/usage/:team` | `ledgerRef` | 팀별 장부 `usage_ledger.entries` JSON 에 파일 ID 와 크기를 넣는다. 팀은 `config/teams.json` 의 접두사 규칙으로 정한다. 같은 팀에서 같은 파일은 한 번만 센다. 조회는 `GLOBAL` 의 전역 캐시를 먼저 본다 | JSON 안의 참조 + 전역 캐시 | 옛 파일 크기가 장부에 남거나, 같은 팀의 다른 이벤트가 쓰는 파일을 장부에서 빼 버림. 캐시가 옛 값을 돌려줌 |
| 장기 보관 | 실행: 레거시 `POST /legacy/archive/run`, 조회: v3 `GET /v3/archive/:incidentId` | `vaultId` | `config/global.json` 의 `archiveEngine` 문자열로 `ARCHIVE.ts` 를 동적으로 불러온다. 실제 보관은 `child_process.fork` 로 띄운 `workers/ARCHIVE_WORKER.ts` 가 하고, 워커는 **자기 메모리와 `vault-index.json`** 에 이벤트별 보관 파일을 기록한다. 이미 보관한 이벤트는 건너뛴다. 워커에는 `evict` 메시지 처리가 있지만 아무도 보내지 않는다 | 별도 프로세스 + 파일 사본 + 예약 작업 | 교체 후 보관을 다시 돌려도 옛 파일이 보관본으로 남음 |
| 웹훅 발송 | 발송: 이벤트 버스 `webhook.dispatch`, 수신: v3 `POST /v3/webhook-sink`, 재전송: 레거시 `POST /legacy/webhooks/retry` | `sigRef` | 발송 본문에 내용 해시(`sigRef`)를 넣고 `GLOBAL` 의 비밀 키로 서명해 `webhook_deliveries` 에 저장한 뒤 내부 HTTP 로 수신 엔드포인트에 보낸다. 재전송은 저장된 본문과 서명을 그대로 다시 보낸다 | 직렬화된 값 + 내부 HTTP | 교체를 발송하지 않으면 외부 시스템은 옛 해시만 알고 있음 |

공유 권한은 파일 ID 로 확인하기 때문에, 같은 파일을 쓰는 다른 이벤트까지 열린다. seed 에서 D 를 공유받은 사람은 C 도 내려받을 수 있다. 교체 전부터 있던 결함이라 채점에는 쓰지 않는다.

`ARCHIVE2.ts`(같은 프로세스에서 도는 대안)와 `ARCHIVE_prev.ts`(이전 구현)도 있지만 실제로는 `ARCHIVE.ts` 만 쓰인다. 어느 것이 쓰이는지는 `config/global.json` 한 곳으로만 결정된다.

## zenius-siem-be 에서 가져온 구조 패턴

코드는 가져오지 않았고, 복잡도를 만드는 형태만 따랐다.

| 패턴 | 이 앱에서의 위치 |
| --- | --- |
| API 세대 공존 | 레거시 `server/routing.ts`(분기문 하나, `{ result, code, data }` 응답), 현재 `server/modules/*`, 새 구조 `server/v3/features/*` (`v3/features.json` 으로 등록) |
| 거의 같은 파일의 변종 | `ARCHIVE.ts`, `ARCHIVE2.ts`, `ARCHIVE_prev.ts` |
| 루트의 대문자 모듈 | `server/GLOBAL.ts`, `server/MYLIB.ts`, `server/ARCHIVE*.ts` |
| 전역 가변 상태 + 설정 파일 저장 | `GLOBAL.ts` 가 `global.APP_STATE` 에 용량 캐시·웹훅 키·마지막 보관 시각을 두고 `.data/evidence/global-state.json` 에 저장 |
| 프로세스 간 결합 | 보관 워커와 `process.send` 메시지 |
| 잡동사니 공용 모듈 | `MYLIB.ts` (해시, 팀 판정, 파일 읽기, 날짜) |
| 문자열로 고르는 구현 | `archiveEngine` 으로 동적 `import` |
| JSON 설정 | `config/teams.json`, `config/global.json`, `v3/features.json` |

## 파일 저장소 — 내용 기반 중복 제거

같은 내용을 올리면 같은 ID 를 돌려준다. 그래서 서로 다른 이벤트, 보고서, export 작업이 한 파일을 공유할 수 있다.
파일을 지우려면 `incident_attachments`, `evidence_items`, `reports`, `export_jobs.manifest` 모두에서 참조가 없어야 한다. 기존 코드의 참조 확인 함수(`isBlobOrphaned`)는 `incident_attachments` 와 `reports` 만 본다.

## 안티패턴 목록

| 안티패턴 | 위치 (예정) | 교체 과제에서 생기는 문제 |
| --- | --- | --- |
| "첨부를 볼 수 있는가" 판정 복사 6곳 | `attachments`, `evidence`, `artifacts`, `documents`, `export`, `preview` 에 조금씩 다르게 | 한 곳만 고치면 나머지는 옛 판정 |
| 같은 값의 이름이 모듈마다 다름 | 위 표 | `fileId` 로 grep 하면 4개 모듈을 놓침 |
| 조회 함수의 숨은 부수효과 | `resolveArtifact` 가 `artifactMemo` 를 채움, `loadEvidence` 가 접근 기록을 남김 | 캐시가 옛 값을 계속 반환 |
| 거대 서비스 파일 | `app/server/services/evidence-service.ts` (1,000줄 이상) | 관련 로직이 한 파일에 섞여 범위 파악이 어려움 |
| 낡은 주석과 README | `evidence-store.ts` 머리 주석 "deprecated, 사용처 없음". `services/evidence-service.ts` 머리 주석 "파일 ID 는 업로드마다 고유". `app/README.md` 의 "파일 ID 는 업로드마다 새로 만들어짐", "v1 은 2025년 하반기에 제거", "evidence 모듈은 더 이상 쓰지 않음", "attachments 모듈이 검색·미리보기를 직접 갱신", "내보내기는 실행할 때 현재 첨부를 모음" | `v1`·export·이벤트 버스를 무시하고, 파일 공유가 없다고 믿게 됨 |
| 파일 저장소 README 가 중복 제거 이전 설명 | `file-store/README.md` 의 "업로드마다 새 ID 를 만든다", "업로드는 항상 201" | 파일 공유가 없다고 믿고 옛 파일을 바로 지움 |
| 쓰이지 않는 것처럼 보이는 경로 | `v1` API — 화면은 안 쓰지만 export 작업이 내부에서 호출 | 교체가 export 에 반영되지 않음 |
| 불완전한 참조 확인 | `services/evidence-service.ts` 의 `isBlobOrphaned`, `removeBlobIfOrphaned` | 공유 파일을 지워 다른 이벤트·export 가 깨짐 |
| 반쪽짜리 점검 도구 | `clearPreviewCache` 는 `preview_cache` 만 지우고 `previewMemo`·`artifactMemo` 는 둔다. `reindexAll` 은 메모리 캐시를 거치는 `resolveArtifact` 로 다시 색인한다. `recordEvidence` 는 `ON CONFLICT DO NOTHING` 이라 다시 불러도 `digest` 가 바뀌지 않는다 | 도구를 썼는데도 미리보기·검색·`v1` 이 옛 파일을 가리킴 |
| 이중 기록 | 첨부 생성 시 `incident_attachments` + `evidence_items` | 교체 시 한쪽만 갱신 |
| 타입 검사 무력화 | `app/tsconfig.json` 의 `strict: false`, `noImplicitAny: false`. 모듈 경계·DB 행·이벤트 페이로드를 `any` 로 주고받는다. 거대 서비스 파일은 `// @ts-nocheck` | 필드 이름을 바꾸거나 반환 모양을 바꿔도 `pnpm build` 가 통과한다. 타입 오류로 영향 범위를 찾을 수 없고, 빌드 통과를 완료 신호로 오해한다 |
| 항상 참인 조건문과 `let` 재할당 | `attachments/availability.ts` (`mode === 'v2' \|\| level > 2 ...`), `evidence/availability.ts` (`state === 'legacy' \|\| ...`), `artifacts/availability.ts`, `documents/availability.ts` (`kind === 'report' \|\| kind.length > 0`), `export/availability.ts` (한 번만 도는 `while`), `export/export-runner.ts` (`outcome` 분기), `preview/availability.ts`, `preview/preview-cache.ts` 의 `getPreview` (`age < 86400000 * 365 \|\| age >= 0`), `search/indexer.ts` (`payload.bytes !== -1`), `search/search.ts`, `stats/counters.ts`, `incidents/incidents.ts` 의 `closeIncident`, `services/evidence-service.ts` 의 `createIncidentWithAttachment` (`LEGACY_COMPAT \|\| stage > 1 \|\| ...`), `isBlobOrphaned` (`orphaned \|\| checks >= 0`) | 조건이 무엇을 거르는지 읽어 내느라 시간을 쓰고, 실제로는 거르지 않는 분기를 근거로 영향이 없다고 판단한다. 특히 `getPreview` 는 캐시 만료가 있는 것처럼 보이지만 메모리 캐시를 항상 돌려준다 |
| 매직 스트링·매직 넘버 | 파일 ID 길이 `64`, 미리보기 `1200`, 색인 본문 `4000`, manifest `500`, 시간 `86400000 * 365`, 조회 상한 `200`·`1000`, 대기열 채널 `'ops-alerts'` (분기마다 같은 값), 작업 상태 `'queued'`·`'running'`·`'completed'`·`'failed'`, 작업 ID 접두사 `'EXP-'`, 카운터 행 `id = 1` 이 상수 없이 여러 파일에 흩어져 있다 | 같은 의미의 값을 한곳에서 바꿀 수 없고, 값의 의미를 찾아 여러 파일을 오가야 한다 |

타입 검사 무력화는 위 모든 항목에 겹쳐 작용한다. 단, `pnpm build` 자체는 항상 통과해야 한다. 빌드가 깨져 있으면 두 조건 모두 그것부터 고치느라 비교가 흐려진다.

## 교체 영향 목록 — 채점 기준

seed 에서 교체 대상과 그 주변을 준비하고, 교체 뒤 아래를 확인한다.

| ID | 확인 대상 | 기대 동작 | 놓치는 경우 |
| --- | --- | --- | --- |
| E1 | `v2` 첨부 다운로드 | 새 이름·새 내용 | (기본 기능) |
| E2 | `v1` 첨부 다운로드 | 새 내용 | `evidence_items` 이중 기록을 갱신하지 않음 |
| E3 | 교체 전에 만든 보고서 다운로드 | 옛 내용 그대로 | 옛 파일을 지움 |
| E4 | 같은 내용을 공유하던 다른 이벤트의 첨부 | 그대로 | 공유 파일을 지움 |
| E5 | 교체 전에 요청한 export 작업 실행 | 성공, 옛 내용 포함 | manifest 참조를 보지 않고 파일을 지움 |
| E6 | 다른 참조가 없는 옛 파일 | 파일 저장소에서 삭제 (파일 수 감소) | 옛 파일을 남김 |
| E7 | 검색 | 새 이름으로 찾아지고 옛 이름으로는 안 찾아짐 | 색인 미갱신 |
| E8 | 미리보기 | 새 내용 | `preview_cache`·`artifactMemo` 미무효화 |
| E9 | 대시보드 카운터 | 첨부 수 그대로, 바이트는 차이만큼 변경 | `attachment.stored` 재사용으로 수 +1, 또는 미갱신 |
| E10 | 감사 로그 | 교체 기록 1건, 옛·새 파일 ID 포함 | 기록 누락 |
| E11 | 알림 대기열 | 교체 알림 1건, 새 파일 ID | 누락, 또는 옛 ID |
| E12 | 없는 이벤트·첨부 없는 이벤트 교체 | 404 | 500 |
| E13 | A 를 공유받은 사람의 v3 다운로드, D 를 공유받은 사람의 v3 다운로드 | A 는 새 내용으로 200, D 는 그대로 200 | 권한이 옛 파일 ID 에 묶여 A 가 403. 또는 `blob_ref` 로 옮겨 D 권한까지 바뀜 |
| E14 | `GET /v3/billing/usage/core` | 사용량이 `core` 팀 이벤트들의 현재 첨부(같은 파일은 한 번) 크기 합과 같다 | 옛 파일이 장부에 남음, 공유 파일을 장부에서 뺌, 전역 캐시가 옛 값 |
| E15 | 교체 후 `POST /legacy/archive/run`, `GET /v3/archive/INC-2001` | 새 내용 | 워커가 이미 보관한 이벤트를 건너뛰어 옛 내용 |
| E16 | 웹훅 수신 기록 `GET /v3/webhook-sink?caseNo=INC-2001` 의 최신 항목 | `sigRef` 가 새 파일의 해시이고 서명 검증 통과 | 교체를 발송하지 않아 최신 항목이 옛 해시 |

화면 확인 (수동): 이벤트 상세의 첨부·미리보기가 새 파일로 바뀌는지, 대시보드 바이트가 바뀌는지.

## seed 준비 사항

| 이벤트 | 준비 | 확인하는 항목 |
| --- | --- | --- |
| 교체 대상 A | 다른 참조 없음 | E1, E2, E6, E7, E8, E9, E10, E11 |
| 교체 대상 B | 감사 보고서 연결 | E3 |
| 교체 대상 C, 비교 대상 D | C 와 D 의 첨부 내용이 같음 (파일 공유) | E4 |
| 교체 대상 E | 교체 전에 export 작업 요청 (실행 전) | E5 |
| 공유 권한 | A 를 `auditor@partner` 에게, D 를 `reviewer@partner` 에게 공유 (레거시 API) | E13 |
| 팀 규칙 | `INC-200*` 는 `core` 팀, `INC-201*` 는 `edge` 팀. C 와 D 가 같은 `core` 팀이라 공유 파일을 한 번만 센다 | E14 |
| 장기 보관 | seed 마지막에 보관을 한 번 실행해 모든 이벤트를 보관해 둔다 | E15 |
| 웹훅 | 첨부를 만들 때마다 자동 발송된다 | E16 |
| 그 밖의 이벤트 | 평범한 데이터 | 대시보드·검색 결과가 자연스럽게 보이도록 |
