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
| 반쪽짜리 점검 도구 | `clearPreviewCache` 는 `preview_cache` 만 지우고 `previewMemo`·`artifactMemo` 는 두다. `reindexAll` 은 메모리 캐시를 거치는 `resolveArtifact` 로 다시 색인한다. `recordEvidence` 는 `ON CONFLICT DO NOTHING` 이라 다시 불러도 `digest` 가 바뀌지 않는다 | 도구를 썼는데도 미리보기·검색·`v1` 이 옛 파일을 가리킴 |
| 이중 기록 | 첨부 생성 시 `incident_attachments` + `evidence_items` | 교체 시 한쪽만 갱신 |
| 타입 검사 무력화 | `app/tsconfig.json` 의 `strict: false`, `noImplicitAny: false`. 모듈 경계·DB 행·이벤트 페이로드를 `any` 로 주고받고, `as any` 캐스팅과 `// @ts-ignore` 를 곳곳에 둔다. 거대 서비스 파일은 `// @ts-nocheck` | 필드 이름을 바꾸거나 반환 모양을 바꿔도 `pnpm build` 가 통과한다. 타입 오류로 영향 범위를 찾을 수 없고, 빌드 통과를 완료 신호로 오해한다 |

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

화면 확인 (수동): 이벤트 상세의 첨부·미리보기가 새 파일로 바뀌는지, 대시보드 바이트가 바뀌는지.

## seed 준비 사항

| 이벤트 | 준비 | 확인하는 항목 |
| --- | --- | --- |
| 교체 대상 A | 다른 참조 없음 | E1, E2, E6, E7, E8, E9, E10, E11 |
| 교체 대상 B | 감사 보고서 연결 | E3 |
| 교체 대상 C, 비교 대상 D | C 와 D 의 첨부 내용이 같음 (파일 공유) | E4 |
| 교체 대상 E | 교체 전에 export 작업 요청 (실행 전) | E5 |
| 그 밖의 이벤트 | 평범한 데이터 | 대시보드·검색 결과가 자연스럽게 보이도록 |
