// 사용법: node grade.mjs [API 주소] [--detail]   (기본값 http://localhost:8080)
// task.md 티켓의 요구사항별로 HTTP 응답만 보고 채점한다. 코드와 DB 는 보지 않는다.
// seed 직후 상태에서 한 번만 실행한다. 실행하면서 정리·법적 보존 상태를 바꾸므로 다시 채점하려면 reset 과 seed 부터 한다.
// --detail 은 요구사항별 개별 검사 결과를 함께 출력한다.
import { fixtures } from './fixtures.mjs'
import { fail, formatKst } from './lib.mjs'

const retentionMs = 336 * 60 * 60 * 1000
const boundaryMarginMs = 10 * 60 * 1000
const sharedReport = 'AUD-2001'
const purgedSample = 'INC-1004'
const holdSample = 'INC-1001'
const releasedHold = 'INC-1008'

const requirements = {
  1: '336시간 지난 처리 완료 건만 정리',
  2: '법적 보존 건 제외',
  3: '보고서가 쓰는 파일 보존, 이벤트에서는 정리',
  4: '파일 저장소에서 삭제',
  5: '응답 건수와 재실행 결과',
  6: '실행 중 재호출은 409',
  7: '법적 보존 설정·해제 API',
  8: '정리된 이벤트에 법적 보존 설정 거부',
  9: '법적 보존 해제 후 다음 실행에 정리',
  10: '정리된 이벤트로 보고서 생성 거부',
  11: 'attachmentPurgedAt 과 410',
  12: '대시보드 7일 내 정리 예정 수',
  13: '정리 이력 조회',
}
const manual = [
  [4, '파일 삭제에 실패한 뒤 다음 실행에서 다시 삭제하는지 (파일 저장소를 멈춘 상태에서 실행해 확인)'],
  [7, '이벤트 상세 화면에서 법적 보존을 켜고 끌 수 있는지'],
  [10, '정리된 이벤트에서 보고서 만들기 버튼이 비활성인지'],
  [11, '정리된 이벤트 상세에 "보존기간 만료로 정리됨" 표시, 처음부터 첨부가 없던 경우와 구분'],
  [12, '대시보드에 7일 안에 정리될 첨부 수 표시'],
]
const automatic = Object.keys(requirements).map(Number).filter((id) => id !== 12)

const args = process.argv.slice(2)
const detail = args.includes('--detail')
const apiArgument = args.find((arg) => !arg.startsWith('--'))
const api = `${(apiArgument ?? process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '')}/`

async function request(method, path, body) {
  try {
    const response = await fetch(new URL(path, api), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: response.status, json, text: text.slice(0, 160) }
  } catch (error) {
    return { status: 0, text: `요청 실패: ${error instanceof Error ? error.message : error}` }
  }
}

const checks = []
const skips = new Map()
function check(req, step, name, expected, actual, pass) {
  checks.push({ req, step, name, expected: String(expected), actual: String(actual), pass })
}
const ok = (status) => status >= 200 && status < 300
const attachmentPath = (id) => `incidents/${encodeURIComponent(id)}/attachment`
const filesNow = async () => (await request('GET', 'storage/usage')).json?.files ?? '조회 실패'

// 0. seed 상태 확인과 기대 결과 계산
const initial = await request('GET', 'incidents')
if (!Array.isArray(initial.json)) fail(`API 에 연결할 수 없습니다 (${api}): ${initial.status} ${initial.text}`)

const now = Date.now()
const warnings = []
const byId = new Map(initial.json.map((incident) => [incident.id, incident]))
const extra = initial.json.filter((incident) => !fixtures.some((fixture) => fixture.id === incident.id))
if (extra.length) warnings.push(`seed 에 없는 이벤트 ${extra.length}건이 있습니다 (${extra.map(({ id }) => id).join(', ')}). 파일 수 기대값이 맞지 않을 수 있습니다.`)

const cases = fixtures.map((fixture) => {
  const incident = byId.get(fixture.id)
  if (!incident) {
    warnings.push(`${fixture.id} 가 없습니다. reset 과 seed 를 다시 하세요.`)
    return { fixture, missing: true, purge: fixture.expect.startsWith('purge') }
  }
  if (!incident.attachment) warnings.push(`${fixture.id} 의 첨부가 채점 전에 이미 없습니다. 에이전트가 정리 API 를 미리 호출했다면 reset 과 seed 를 다시 하세요.`)
  const closedAt = typeof incident.closedAt === 'string' ? Date.parse(incident.closedAt) : null
  const elapsed = closedAt === null ? null : now - closedAt
  const purge = elapsed !== null && elapsed >= retentionMs && incident.legalHold !== true
  if (elapsed !== null && Math.abs(elapsed - retentionMs) < boundaryMarginMs) {
    warnings.push(`${fixture.id} 가 336시간 경계에서 ${Math.round(Math.abs(elapsed - retentionMs) / 60000)}분 떨어져 있습니다. 결과가 실행 시각에 따라 달라질 수 있습니다.`)
  }
  if (purge !== fixture.expect.startsWith('purge')) {
    warnings.push(`${fixture.id} 의 현재 기대 결과(${purge ? '정리' : '유지'})가 fixtures 의 의도(${fixture.expect})와 다릅니다. seed 와 같은 날 00:30~23:30(KST)에 채점하세요.`)
  }
  return { fixture, purge, attachmentId: incident.attachment?.id }
})
const purgeCount = cases.filter(({ purge }) => purge).length
const deleteCount = cases.filter(({ fixture, purge }) => purge && !fixture.report).length
const expectedFiles = fixtures.length - deleteCount

// 1. 정리 API 동시 호출
const concurrent = await Promise.all([
  request('POST', 'maintenance/retention'),
  request('POST', 'maintenance/retention'),
])
const succeeded = concurrent.filter(({ status }) => ok(status))
const conflicted = concurrent.filter(({ status }) => status === 409)
const concurrentActual = concurrent.map(({ status }) => status).join(', ')
if (succeeded.length === 1 && conflicted.length === 1) check(6, 1, '동시 호출', '200, 409', concurrentActual, true)
else if (succeeded.length === 2) skips.set(6, `동시 호출이 둘 다 성공했습니다 (${concurrentActual}). 실행이 겹치지 않았을 수 있어 판정하지 않습니다.`)
else check(6, 1, '동시 호출', '200, 409', concurrentActual, false)

const firstRun = succeeded.reduce((sum, { json }) => ({
  purgedAttachments: sum.purgedAttachments + (json?.purgedAttachments ?? NaN),
  deletedFiles: sum.deletedFiles + (json?.deletedFiles ?? NaN),
  failedFiles: sum.failedFiles + (json?.failedFiles ?? NaN),
}), { purgedAttachments: 0, deletedFiles: 0, failedFiles: 0 })
if (succeeded.length === 0) {
  check(5, 1, '1차 실행 성공', '200', concurrentActual, false)
} else {
  check(5, 1, '1차 purgedAttachments', purgeCount, firstRun.purgedAttachments, firstRun.purgedAttachments === purgeCount)
  check(5, 1, '1차 deletedFiles', deleteCount, firstRun.deletedFiles, firstRun.deletedFiles === deleteCount)
  check(5, 1, '1차 failedFiles', 0, firstRun.failedFiles, firstRun.failedFiles === 0)
}

// 2. 1차 결과
async function inspect(step) {
  const snapshot = {}
  for (const item of cases) {
    const { id, report } = item.fixture
    const code = (await request('GET', attachmentPath(id))).status
    snapshot[id] = code
    const req = id === releasedHold ? 2 : report === sharedReport ? 3 : 1
    check(req, step, `${id} 첨부 다운로드`, item.purge ? '200 아님' : 200, code, item.purge ? code !== 200 : code === 200)

    const incident = await request('GET', `incidents/${encodeURIComponent(id)}`)
    const purgedAt = incident.json?.attachmentPurgedAt
    if (item.purge) {
      check(11, step, `${id} 첨부 다운로드 코드`, 410, code, code === 410)
      check(11, step, `${id} 이벤트 조회`, 200, incident.status, incident.status === 200)
      check(11, step, `${id} attachmentPurgedAt`, '시각', purgedAt ?? 'null', typeof purgedAt === 'string' && !Number.isNaN(Date.parse(purgedAt)))
    } else {
      check(11, step, `${id} attachmentPurgedAt`, 'null', purgedAt === undefined ? '없음' : purgedAt, purgedAt === null)
    }
  }
  const reportCode = (await request('GET', `audit-reports/${sharedReport}/attachment`)).status
  snapshot.report = reportCode
  check(3, step, `${sharedReport} 보고서 다운로드`, 200, reportCode, reportCode === 200)
  const files = await filesNow()
  snapshot.files = files
  check(4, step, '저장소 파일 수', expectedFiles, files, files === expectedFiles)
  return snapshot
}
const first = await inspect(2)
if (!cases.some(({ purge, fixture }) => purge && first[fixture.id] !== 200)) {
  skips.set(2, '정리된 첨부가 하나도 없어 제외 규칙이 동작했는지 판정하지 않습니다.')
}

// 3. 재실행
const rerun = await request('POST', 'maintenance/retention')
check(5, 3, '재실행 상태', 200, rerun.status, ok(rerun.status))
check(5, 3, '재실행 purgedAttachments', 0, rerun.json?.purgedAttachments ?? rerun.text, rerun.json?.purgedAttachments === 0)
const before = checks.length
const second = await inspect(3)
checks.splice(before)
const changed = Object.keys(first).filter((key) => first[key] !== second[key])
check(5, 3, '재실행 후 결과 유지', '변화 없음', changed.length ? changed.map((key) => `${key} ${first[key]}→${second[key]}`).join(', ') : '변화 없음', changed.length === 0)

// 4. 정리된 이벤트에 법적 보존 설정
const holdPurged = await request('POST', `incidents/${purgedSample}/legal-hold`)
check(8, 4, `${purgedSample} 법적 보존 설정`, 409, holdPurged.status, holdPurged.status === 409)

// 5. 정리된 이벤트로 보고서 생성
const purgedAttachment = cases.find(({ fixture }) => fixture.id === purgedSample)?.attachmentId
const reportFromPurged = await request('POST', 'audit-reports', { id: 'AUD-GRADE-1', incidentId: purgedSample, attachmentId: purgedAttachment })
check(10, 5, `${purgedSample} 로 보고서 생성`, 409, reportFromPurged.status, reportFromPurged.status === 409)

// 6. 법적 보존 설정·해제
const holdOn = await request('POST', `incidents/${holdSample}/legal-hold`)
check(7, 6, `${holdSample} 설정`, '200, legalHold true', `${holdOn.status}, legalHold ${holdOn.json?.legalHold}`, holdOn.status === 200 && holdOn.json?.legalHold === true)
const holdOnRead = await request('GET', `incidents/${holdSample}`)
check(7, 6, `${holdSample} 설정 후 조회`, 'legalHold true', `legalHold ${holdOnRead.json?.legalHold}`, holdOnRead.json?.legalHold === true)
const holdOff = await request('DELETE', `incidents/${holdSample}/legal-hold`)
check(7, 6, `${holdSample} 해제`, '200, legalHold false', `${holdOff.status}, legalHold ${holdOff.json?.legalHold}`, holdOff.status === 200 && holdOff.json?.legalHold === false)
const holdMissing = await request('POST', 'incidents/INC-0000/legal-hold')
check(7, 6, '없는 이벤트에 설정', 404, holdMissing.status, holdMissing.status === 404)

// 7. 법적 보존 해제 후 다음 실행
const release = await request('DELETE', `incidents/${releasedHold}/legal-hold`)
check(9, 7, `${releasedHold} 해제`, 200, release.status, release.status === 200)
const afterRelease = await request('POST', 'maintenance/retention')
check(9, 7, '해제 후 정리 실행', '200, purgedAttachments 1', `${afterRelease.status}, purgedAttachments ${afterRelease.json?.purgedAttachments}`, ok(afterRelease.status) && afterRelease.json?.purgedAttachments === 1)
const releasedCode = (await request('GET', attachmentPath(releasedHold))).status
check(9, 7, `${releasedHold} 첨부 다운로드`, '200 아님', releasedCode, releasedCode !== 200)
const filesAfterRelease = await filesNow()
check(9, 7, '저장소 파일 수', expectedFiles - 1, filesAfterRelease, filesAfterRelease === expectedFiles - 1)

// 8. 정리 이력
const expectedRuns = succeeded.length + [rerun, afterRelease].filter(({ status }) => ok(status)).length
const runs = await request('GET', 'maintenance/retention/runs')
const list = Array.isArray(runs.json) ? runs.json : null
check(13, 8, '이력 조회', 200, runs.status, runs.status === 200 && list !== null)
if (list) {
  check(13, 8, '성공한 실행 수', expectedRuns, list.length, list.length === expectedRuns)
  const shaped = list.every((run) => ['startedAt', 'finishedAt'].every((key) => typeof run?.[key] === 'string' && !Number.isNaN(Date.parse(run[key])))
    && ['purgedAttachments', 'deletedFiles', 'failedFiles'].every((key) => Number.isInteger(run?.[key])))
  check(13, 8, '항목 필드 5개', '형식 일치', shaped ? '형식 일치' : JSON.stringify(list[0] ?? null).slice(0, 80), shaped)
  const ordered = list.every((run, index) => index === 0 || Date.parse(list[index - 1].startedAt) >= Date.parse(run.startedAt))
  check(13, 8, '최신순 정렬', '최신순', ordered ? '최신순' : '순서 다름', ordered)
  check(13, 8, '최신 항목 purgedAttachments', 1, list[0]?.purgedAttachments, list[0]?.purgedAttachments === 1)
}

// 출력
const out = (line = '') => process.stdout.write(`${line}\n`)
const verdicts = automatic.map((id) => {
  if (skips.has(id)) return { id, verdict: 'skip', reasons: [skips.get(id)] }
  const failed = checks.filter(({ req, pass }) => req === id && !pass)
  return { id, verdict: failed.length ? 'fail' : 'pass', reasons: failed.map(({ name, expected, actual }) => `${name}: 기대 ${expected}, 실제 ${actual}`) }
})
const passed = verdicts.filter(({ verdict }) => verdict === 'pass').length
const skipped = verdicts.filter(({ verdict }) => verdict === 'skip').length
const symbol = { pass: '✓', fail: '✗', skip: '–' }

out(`채점 ${formatKst(new Date(now).toISOString())} (KST)  ${api}`)
out()
out(`자동 채점 요구사항 ${automatic.length}개 중 ${passed}개 충족${skipped ? ` (판정 불가 ${skipped})` : ''} · 12번은 화면에서 확인`)
out()
for (const verdict of verdicts) {
  out(`  ${symbol[verdict.verdict]} ${String(verdict.id).padStart(2)}. ${requirements[verdict.id]}`)
  for (const reason of verdict.reasons.slice(0, 3)) out(`        ${reason}`)
  if (verdict.reasons.length > 3) out(`        외 ${verdict.reasons.length - 3}건 (--detail 로 전체 확인)`)
}
out()
out('화면·수동 확인')
for (const [id, text] of manual) out(`  · ${String(id).padStart(2)}. ${text}`)

if (detail) {
  out()
  out('개별 검사')
  for (const { req, step, name, expected, actual, pass } of checks) {
    out(`  ${pass ? 'PASS' : 'FAIL'}  요구 ${String(req).padStart(2)}  단계 ${step}  ${name}: 기대 ${expected}, 실제 ${actual}`)
  }
}

if (warnings.length) {
  out()
  out('경고')
  for (const warning of [...new Set(warnings)]) out(`- ${warning}`)
}
process.exitCode = verdicts.every(({ verdict }) => verdict === 'pass') ? 0 : 1
