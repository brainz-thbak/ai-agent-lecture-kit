---
name: orchestrate-feedback
description: 요구사항 구체화, 회귀 영향 분석, 구현, 독립 검증을 서브에이전트에 연결한다. 구현 전후 기준선에 따라 요구사항과 코드를 각각 보완하는 피드백 루프에 사용한다.
---

# 구현 피드백 루프

필요 환경: Node.js 18 이상. 노드 이동은 이 스킬 폴더의 `scripts/transition.mjs` 로만 한다.

## 작업 폴더

모든 산출물은 작업 폴더 하나에 둔다. 요청에서 경로를 지정하지 않았으면 에이전트를 실행한 작업공간의 `.feedback/<task_id>/` 를 쓴다.

```text
.feedback/<task_id>/
  state.json             현재 노드와 전이 근거 (전이 스크립트만 수정한다)
  transitions.log        전이 기록
  requirements.md        요구사항. 갱신해도 같은 파일을 쓴다
  analysis-<n>.json      회귀 분석 응답. 회차마다 새 파일
  cases.md               확정 케이스
  implementation-<n>.md  구현자 보고. 회차마다 새 파일
  verification-<n>.json  검증 응답. 회차마다 새 파일
```

이 폴더 밖의 프로젝트 파일(예: `.gitignore`)은 산출물을 위해 바꾸지 않는다.

## 전이 스크립트로만 이동한다

```sh
node <스킬 폴더>/scripts/transition.mjs init <task_id> [--dir <작업 폴더>]
node <스킬 폴더>/scripts/transition.mjs status --dir <작업 폴더>
node <스킬 폴더>/scripts/transition.mjs move <다음 노드> --dir <작업 폴더> [--evidence <파일>] [--reason <사유>]
```

1. 작업을 시작할 때 `init` 을 실행하고, 출력된 작업 폴더 경로를 이후 모든 명령에 쓴다. 이미 시작한 작업이면 `status` 로 현재 노드부터 이어간다.
2. [순서도와 전이 조건](references/workflow.md)에 따라 현재 노드의 작업을 수행하고, 다음 노드로 갈 때 `move` 를 실행한다. 근거가 필요한 전이는 작업 폴더에 저장한 파일을 `--evidence` 로 넘긴다.
3. **`move` 가 거부하면 그 노드에 머문다.** 출력된 사유를 해결한 뒤 다시 시도한다. 스크립트를 거치지 않고 다음 단계의 작업을 시작하지 않는다. `state.json` 을 직접 고치지 않는다.
4. 완료는 `done` 에 도달했을 때만 선언한다. `incomplete` 로 갈 때는 `--reason` 에 아직 끝나지 않은 항목과 진행을 막는 이유를 적고, 같은 내용을 요청자에게 보고한다.

## 응답을 확보하지 못했을 때

서브에이전트가 응답 없이 종료되거나, 응답이 형식에 맞지 않거나, 다른 요구사항·작업을 대상으로 한 응답이면 **그 응답을 대신해 판정하지 않는다.**

1. 같은 입력으로 서브에이전트를 다시 실행한다. 응답 파일 경로를 새로 정해 전달한다.
2. 다시 실행해도 유효한 응답을 얻지 못하면 `incomplete` 로 이동한다.

"요구사항을 보완했으니 분석 공백이 해소되었다"처럼, 오케스트레이터가 직접 판단해 판정을 대신하지 않는다. 요구사항을 고쳤다면 그 요구사항으로 다시 분석한다.

## 구현 전

- **`refine`** — [요구사항 구체화 스킬](../refine-requirements/SKILL.md)로 작업 폴더의 `requirements.md` 를 작성한다. 맨 위 front matter 에 `task_id` 를 적고, 프로젝트 지침에서 찾은 빌드·타입 검사·테스트 명령을 `## 검증 명령` 절에 적는다. `revise` 에서 돌아왔으면 직전 분석의 `REQUIREMENT_GAP` 이슈를 모두 전달하고, 각 이슈가 수용 기준이나 미결 결정으로 반영되었는지 확인한다.
- **`analyze`** — [회귀 영향 분석 스킬](../analyze-regression-impact/SKILL.md)을 실행한다. `status` 로 확인한 `task_id`, `requirements_hash`, 요구사항 파일 경로와 새 응답 파일 경로(`analysis-<n>.json`)를 전달하고, 응답을 그 파일에 저장하게 한다. 저장된 파일을 `--evidence` 로 넘겨 `requirementsGate` 로 이동한다.
- **`requirementsGate`** — 분석 판정에 따라 `cases`(PASS), `revise`(REVISE), `clarify`(BLOCKED)로 이동한다. 스크립트가 판정과 다른 이동을 거부한다.
- **`revise` / `clarify`** — `revise` 는 분석의 보완점을 정리해 `refine` 으로 돌아간다. `clarify` 는 필요한 결정을 요청자에게 확인하거나 자료를 확보한 뒤 `refine` 으로 돌아간다.
- **`cases`** — 작업 폴더의 `cases.md` 에 신규 동작과 회귀 케이스를 확정한다. 모든 수용 기준(`AC-xx`)과 분석의 `REQUIRED` 회귀 후보(`REG-xx`)를 케이스에 하나 이상 연결한다. 케이스마다 `CASE-01` 형식의 ID, 관련 기준·후보 ID, 필수 여부, 사전 조건, 실행 절차, 기대 결과를 적고 상태를 `UNVERIFIED` 로 둔다. 분석 후보의 `verification` 을 회귀 케이스의 절차와 기대 결과로 옮긴다. `cases.md` 를 `--evidence` 로 넘겨 `implement` 로 이동한다.

## 구현과 검증

- **`implement`** — **첫 구현과 수정은 반드시 구현 서브에이전트에 위임한다.** 첫 구현에는 구현자 한 명을 실행하고, 재작업은 기존 구현자에게 이어서 맡긴다. 작업 ID, 요구사항 파일과 확정 케이스 경로, 작업공간과 수정 범위, 보고를 저장할 파일 경로(`implementation-<n>.md`)를 전달한다. 구현자는 제품 코드만 수정하며 요구사항과 테스트 케이스의 수정 및 테스트 실행은 금지한다. 보고 파일에 변경 파일, 변경 내용, 남은 문제를 적게 하고, 그 파일을 `--evidence` 로 넘겨 `verify` 로 이동한다. 요구사항이나 케이스가 바뀌었으면 스크립트가 거부한다.
- **`verify`** — 별도의 검증 서브에이전트를 실행한다. [구현·회귀 검증 스킬](../verify-implementation/SKILL.md)에 요구사항 파일, 확정 케이스, 현재 변경 범위, 응답 파일 경로(`verification-<n>.json`)를 전달한다. 첫 검증과 재검증 모두 확정된 신규 동작 및 회귀 케이스와 `## 검증 명령` 을 모두 실행한다. 검증 명령을 실행하지 못했다면 검증 판정은 `PASS` 가 될 수 없다. 저장된 응답을 `--evidence` 로 넘겨 `verificationGate` 로 이동한다.
- **`verificationGate`** — 검증 판정에 따라 `done`(PASS), `feedback`(FAIL), `resolve`(BLOCKED)로 이동한다.
- **`feedback`** — 실패한 케이스 ID, 재현 절차, 기대값, 실제값을 기존 구현자에게 전달하고 `implement` 로 돌아간다. 새 근거 없이 같은 실패가 반복되면 `incomplete` 로 간다.
- **`resolve`** — 누락된 입력, 테스트 또는 실행 환경 문제를 해결하고 `verify` 로 돌아간다. 기대 동작에 새 결정이 필요하면 요청자에게 확인하고 `refine` 으로 돌아간다.
