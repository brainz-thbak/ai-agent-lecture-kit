# 피드백 루프 순서도

```mermaid
flowchart TD
    input([사용자 요구사항]) --> refine["요구사항 구체화<br/>작업 ID를 담은 Markdown 파일 저장"]
    refine --> analyze["회귀 영향 분석 스킬<br/>코드 분석 서브에이전트에 조사 위임 · 근거 검토"]
    analyze -->|유효한 분석 응답| requirementsGate{"요구사항 기준선 판정"}
    analyze -->|응답 확보 불가| incomplete
    requirementsGate -->|REVISE| revise["누락·충돌을 요구사항에 반영"]
    revise --> refine
    requirementsGate -->|BLOCKED| clarify["필요한 정책 결정 또는 자료 확보"]
    clarify -->|확보| refine
    clarify -->|확보 불가| incomplete([미해결 항목 보고])
    requirementsGate -->|PASS| cases["오케스트레이터가 테스트 케이스 확정<br/>신규 동작 및 회귀 · 미검증"]
    cases --> implement["구현 서브에이전트 실행<br/>제품 코드 수정 · 테스트 수정 및 실행 금지"]
    implement -->|위임 불가 또는 확정 입력 복구 불가| incomplete
    implement -->|변경 수신 및 확정 입력 보존 확인| verify["별도 검증 서브에이전트<br/>요구사항 파일과 작업 ID 확인 · 확정 케이스 실행"]
    verify -->|유효한 검증 응답| verificationGate{"구현·회귀 검증 판정"}
    verify -->|응답 확보 불가| incomplete
    verificationGate -->|FAIL| feedback["실패 근거를 같은 구현 에이전트에 전달"]
    feedback -->|기존 구현자에게 수정 위임| implement
    feedback -->|진전 없는 반복| incomplete
    verificationGate -->|BLOCKED| resolve["검증 장애 해결"]
    resolve -->|테스트·환경 해결| verify
    resolve -->|기대 동작 변경 필요| refine
    resolve -->|해결 불가| incomplete
    verificationGate -->|PASS| done([완료])
```

## 전이 조건

| 이동 | 확인할 근거 |
| --- | --- |
| `refine → analyze` | 작업 ID가 담긴 실제 요구사항 파일을 읽을 수 있다. |
| `analyze → requirementsGate` | 현재 요구사항을 입력으로 실행한 회귀 분석이 응답 형식에 맞는 결과를 반환했다. |
| `requirementsGate → cases` | 분석이 `PASS`다. `REVISE`는 보완점을 정리해 `refine`으로 돌아가고, `BLOCKED`는 필요한 결정이나 자료를 먼저 확보한다. |
| `cases → implement` | 모든 수용 기준과 중요한 회귀 후보에 필수 케이스가 연결됐고 기대 결과가 확정됐다. |
| `implement → verify` | 구현자의 변경 결과를 받았다. 요구사항 파일과 확정 테스트 케이스가 그대로인지 확인했다. 위임 불가 또는 확정 입력의 변경을 해결할 수 없으면 `incomplete`로 간다. |
| `verify → verificationGate` | 검증 응답의 형식이 맞고 같은 작업 ID, 요구사항 파일, 최신 구현에 대한 결과임을 확인했다. |
| `verificationGate → feedback` | `FAIL`이며 재현 절차와 기대값·실제값이 있다. 기존 구현자에게 수정을 맡긴 뒤 최신 코드로 검증을 반복한다. |
| `verificationGate → resolve` | `BLOCKED`의 사유와 다음 행동이 있다. 입력이나 환경을 복구하면 `verify`로 돌아가고, 기대 동작의 변경이 필요하면 `refine`으로 돌아간다. |
| `verificationGate → done` | `PASS`이고 확정된 필수 케이스를 모두 실행해 통과한 결과가 있다. |
