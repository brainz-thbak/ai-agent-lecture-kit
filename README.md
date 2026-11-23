# AI 에이전트 강의 키트

`ai-agent-study` 저장소의 같은 앱(`app`)에서 단순 세션과 스킬·피드백 루프의 결과를 비교하는 도구다.
에이전트가 정답을 보지 못하도록 이 저장소는 `ai-agent-study` 밖에 둔다.

| 파일 | 내용 |
| --- | --- |
| `answers.md` | 에이전트가 결정을 물을 때 줄 강사 답변표 |
| `task.md` | 에이전트에 입력할 과제 티켓(요구사항 13개)과 놓치기 쉬운 곳 |
| `reset.mjs` | 앱 DB 와 file-store 데이터 전체 초기화 |
| `seed.mjs` | 첨부 교체 과제 데이터를 API 로 입력 (교체 대상 A·B·C·E, 비교 대상 D) |
| `grade.mjs` | 첨부 교체 과제 채점 (E1~E16, HTTP 응답만 사용) |
| `skills/` | 피드백 루프 조건에서만 설치하는 Codex 스킬 4개 (`orchestrate-feedback` 이 진입점). 노드 이동은 `orchestrate-feedback/scripts/transition.mjs` 로만 하며 Node.js 18 이상이 필요하다 |

Node.js 24 이상에서 의존성 없이 실행한다.

## 진행 순서

아래에서 `STUDY` 는 `ai-agent-study` 저장소 경로다.

1. 서버를 모두 종료하고 초기화한다.

   ```sh
   node reset.mjs $STUDY
   ```

2. 단순 세션 조건을 실행한다. 조건마다 `main` 에서 브랜치를 새로 만들고, 서버 시작과 seed 부터 다시 한다.

   ```sh
   cd $STUDY && git switch -c run/session main
   pnpm dev                                # 다른 터미널에서 계속 실행
   node seed.mjs                           # 키트 저장소에서, 기본 http://localhost:8080
   ```

   **에이전트가 실행되는 동안 키트를 디스크에 두지 않는다.** 에이전트는 상위 폴더를 탐색해 `grade.mjs` 를 읽을 수 있다. seed 뒤에 키트 폴더를 지우고, 에이전트가 끝나면 다시 받는다.

   `$STUDY/app` 에서 에이전트를 띄우고 `task.md` 의 문장을 입력한다. 두 조건 모두 같은 명령으로 띄운다.

   ```sh
   cd $STUDY/app && codex --dangerously-bypass-approvals-and-sandbox
   ```

   샌드박스를 끄는 이유: 검증 명령 `pnpm build` 가 저장소 루트의 `pnpm-lock.yaml` 과 `node_modules` 를 건드리는데, Windows 샌드박스에서는 `--add-dir` 로 루트를 열어도 lockfile 쓰기가 거부되었다. 샌드박스가 꺼지면 에이전트가 저장소 밖 파일도 읽고 쓸 수 있으므로, 키트를 지우는 단계를 반드시 지킨다.

   에이전트가 결정을 물으면 `answers.md` 의 문장으로 답한다. 두 조건에 같은 문장을 쓰고, 묻지 않은 결정은 알려 주지 않는다. 키트를 지우기 전에 답변표를 다른 기기에 띄워 두거나 출력해 둔다. 끝나면 키트를 다시 받아 서버가 켜진 상태에서 채점하고 결과를 브랜치에 커밋한다.

   ```sh
   git clone https://github.com/brainz-thbak/ai-agent-lecture-kit.git
   node grade.mjs                          # 기본 http://localhost:8080
   ```

3. 피드백 루프 조건을 실행한다. 서버를 끄고 reset 한 뒤 `main` 에서 새 브랜치를 만든다.

   ```sh
   node reset.mjs $STUDY
   cd $STUDY && git switch -c run/feedback main
   pnpm dev
   node seed.mjs
   mkdir -p $STUDY/app/.codex && cp -R skills $STUDY/app/.codex/   # 키트를 지우기 전에 스킬 설치
   ```

   같은 방식으로 진행하고, 티켓 앞에 `$orchestrate-feedback` 을 붙여 스킬을 호출한다. 스킬은 `$STUDY/app/.codex` 에만 설치한다. `~/.codex/skills` 처럼 전역 위치에 두면 단순 세션 조건에도 적용된다. 스킬의 산출물(요구사항, 분석, 확정 케이스, 구현 보고, 검증 결과, 전이 기록)은 `$STUDY/app/.feedback/<task_id>/` 에 남는다. 채점이 끝나면 산출물을 실행용 브랜치에 커밋하고 `$STUDY/app/.codex` 를 지운다.

## 채점

`grade.mjs` 는 `design/answer-key.md` 의 E1~E16 을 HTTP 응답만 보고 판정한다. 에이전트 작업이 끝나면 서버를 켠 채로 실행한다.

```sh
node grade.mjs                          # 기본 http://localhost:8080
```

1. seed 직후 상태인지 확인한다. 교체 대상 첨부가 이미 바뀌어 있으면 채점하지 않는다.
2. 교체 전 기준값을 남긴다. A 의 미리보기와 `core` 팀 용량을 한 번 조회해 캐시를 채운다.
3. A(`INC-2001`)·B(`INC-2002`)·C(`INC-2003`)·E(`INC-2005`) 를 `PUT /incidents/:id/attachment` 로 교체한다.
4. E1~E16 을 판정하고 표로 출력한다. 모두 통과하면 종료 코드 0 이다.

```text
16개 중 12개 통과 · 부분 1

  ✓ E1   v2 첨부 다운로드  —  새 이름·새 내용
  ✗ E5   대기 중인 내보내기  —  failed 증빙 1건을 찾을 수 없습니다.
  △ E10  감사 로그  —  새 ID 기록, 옛 ID 없음
  ✓ E13  공유 권한  —  A 공유자 200 새 내용, D 공유자 200
```

- `✓` 통과, `✗` 실패, `△` 부분(E10: 새 ID 만 기록), `–` 판정 불가.
- 옛 파일을 하나도 지우지 않으면 E3·E4·E5 는 저절로 통과하므로 판정 불가로 둔다.
- 교체 요청이 실패하면 교체 결과를 보는 항목은 모두 실패로 둔다.
- 채점이 데이터를 바꾸므로 **seed 직후 한 번만** 실행한다. 다시 채점하려면 reset 과 seed 부터 한다.
- "보존기간 만료로 정리됨" 같은 화면 표시는 이 과제에 없다. 화면 확인은 필요할 때 따로 한다.

## 주의

- 결정은 에이전트가 물을 때만 `answers.md` 대로 알려 준다. 피드백 루프는 판단을 미루지 못하고 묻도록 강제되어 있고, 단순 세션도 물으면 같은 답을 받는다.
- seed 는 이벤트가 없는 빈 서버에만 넣는다. reset 후 서버를 띄우고, 에이전트를 실행하기 전에 seed 한다.
- 에이전트가 개발 중에 seed 이벤트를 직접 교체할 수 있다. 그러면 `grade.mjs` 가 채점을 거부하므로 reset 과 seed 부터 다시 한다. 검증용으로 다른 ID 의 이벤트를 만든 것은 채점에 영향을 주지 않는다.
- `reset.mjs` 는 기본 데이터 경로(`app/.data/evidence`, `file-store/.data`)만 지운다. `seed.mjs` 와 `grade.mjs` 는 API 주소를 인자로 받는다.
