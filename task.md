# 과제 문구

두 조건에 아래 문장을 그대로 입력한다. 숨긴 정책은 없다. 교체 후에도 기존 기능이 일관되게 동작하는지를 비교한다.
무엇이 어디서 얽혀 있는지는 [design/answer-key.md](design/answer-key.md) 에 있다.

- 단순 세션 — 문장만 입력한다.
- 피드백 루프 — 오케스트레이션 스킬을 호출하면서 같은 문장을 입력한다. 예: `$orchestrate-feedback` 뒤에 문장.

```text
이벤트 첨부를 새 파일로 교체할 수 있게 해줘.
PUT /incidents/:id/attachment 에 { "name": 파일 이름, "content": 파일 내용 } 을 보내면 첨부가 바뀌고, 200 과 갱신된 이벤트를 돌려준다.
```
