# AI 에이전트 강의 키트

`ai-agent-study` 저장소로 단순 세션(`basic`)과 스킬·피드백 루프(`with-feedback`)의 결과를 비교하는 도구다.
에이전트가 정답을 보지 못하도록 이 저장소는 `ai-agent-study` 밖에 둔다.

| 파일 | 내용 |
| --- | --- |
| `task.md` | 에이전트에 입력할 과제 문구와 숨겨 둔 함정 |
| `answers.md` | 에이전트 질문에 줄 강사 답변표 |
| `fixtures.mjs` | seed 데이터 15건과 건별 기대 결과 |
| `reset.mjs` | 앱 DB 와 file-store 데이터 전체 초기화 |
| `seed.mjs` | 실행일 기준 날짜로 seed 데이터 입력 |
| `grade.mjs` | 정리 API 를 두 번 실행하고 HTTP 응답으로 채점 |

Node.js 24 이상에서 의존성 없이 실행한다.

## 진행 순서

아래에서 `STUDY` 는 `ai-agent-study` 저장소 경로다.

1. 서버를 모두 종료하고 초기화한다.

   ```sh
   node reset.mjs $STUDY
   ```

2. `basic` 조건을 실행한다. 두 백엔드가 같은 8080 포트를 쓰므로 한 조건씩 진행한다.

   ```sh
   cd $STUDY && git switch -c run/basic main
   pnpm dev                                # 다른 터미널에서 계속 실행
   node seed.mjs $STUDY/basic              # 키트 저장소에서
   ```

   `$STUDY/basic` 에서 에이전트를 띄우고 `task.md` 의 문장을 입력한다. 에이전트가 질문하면 `answers.md` 대로 답한다. 끝나면 서버가 켜진 상태에서 채점하고 결과를 브랜치에 커밋한다.

   ```sh
   node grade.mjs                          # 기본 http://localhost:8080
   ```

3. `with-feedback` 조건을 실행한다. 에이전트가 공용 `fe`, `file-store` 를 고쳤을 수 있으므로 `main` 에서 새 브랜치를 만든다.

   ```sh
   cd $STUDY && git switch -c run/with-feedback main
   pnpm dev:feedback
   node seed.mjs $STUDY/with-feedback
   ```

   `$STUDY/with-feedback` 에서 같은 방식으로 진행한다.

## 채점

`grade.mjs` 는 코드와 DB 를 보지 않고 API 응답만 확인한다. `POST /maintenance/retention` 을 두 번 호출한 뒤, 결과를 `task.md` 의 함정과 기본 동작 단위로 보여준다.

```text
함정 6개 중 3개 통과 · 기본 동작 5개 중 5개 통과

함정
  ✓ 336시간 지난 경계 건 정리  ("14일 초과"로 읽으면 놓친다)
  ✗ 법적 보존 건 유지  (정책 문서의 제외 규칙)
      INC-1008 첨부: 기대 200, 실제 404
```

- `✓` 통과, `✗` 실패, `–` 판정 불가. 실패하면 어떤 요청이 무엇을 반환했는지 아래에 적는다.
- "유지" 쪽 항목은 아무것도 정리하지 않으면 저절로 통과한다. 그래서 정리된 첨부가 한 건도 없으면 판정 불가로 둔다.
- 기대 결과는 API 의 `closedAt`·`legalHold` 와 채점 시각으로 계산한다. 모두 통과하면 종료 코드 0 이다.
- `--detail` 을 붙이면 항목별 응답 코드를 1·2회차로 함께 출력한다.
- "보존기간 만료로 정리됨" 화면 표시는 확인하지 않으므로 이벤트 상세 화면에서 직접 확인한다.

## 주의

- **에이전트가 묻지 않은 결정은 알려 주지 않는다.** 정답이 문서에 없고 강사만 갖고 있어야 질문하는 쪽과 추측하는 쪽의 차이가 드러난다.
- **seed 와 채점은 같은 날 00:30~23:30(KST) 사이에 한다.** 정리 기능은 실제 현재 시각으로 판단하고, 경계 건(INC-1002, INC-1003)은 이 시간대에서만 기대 결과가 성립한다.
- seed 는 스키마 버전 3 인 빈 DB 에만 넣는다. 서버를 한 번 실행해 DB 가 만들어진 뒤, 에이전트를 실행하기 전에 seed 한다.
- 에이전트가 개발 중에 이벤트를 추가하거나 정리 API 를 미리 호출할 수 있다. 채점 전에 seed 데이터가 그대로인지 확인한다.
- `DEMO_DATA_DIR`, `FILE_STORE_URL`, `FILE_STORE_SPACE` 를 바꿔 서버를 실행했다면 seed 에도 같은 값을 준다. `reset.mjs` 는 기본 경로만 지운다.
