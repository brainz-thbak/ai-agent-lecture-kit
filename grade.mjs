// 사용법: node grade.mjs [API 주소] [--detail]   (기본값 http://localhost:8080)
// 결과는 task.md 의 함정 단위로 묶어 보여준다. --detail 은 항목별 응답 코드를 함께 출력한다.
// POST /maintenance/retention 을 두 번 호출하고, 매번 HTTP 응답만으로 결과를 확인한다.
// 기대 결과는 API 가 돌려주는 closedAt·legalHold 와 현재 시각으로 계산한다.
//   정리 대상: 처리 완료 후 336시간 이상 지났고 legal hold 가 아닌 이벤트
//   정리 대상 이벤트의 첨부 다운로드는 200 이 아니어야 하고, 나머지는 200 이어야 한다.
//   정리 대상 이벤트 자체는 남아 있어야 한다 (이벤트 조회 200).
//   감사 보고서 AUD-2001 의 다운로드는 200 이어야 한다.
//   저장소 파일 수는 정리 대상 중 보고서가 쓰지 않는 파일만큼 줄어야 한다.
import { fixtures } from './fixtures.mjs'
import { fail, formatKst } from './lib.mjs'

const retentionMs = 336 * 60 * 60 * 1000
const boundaryMarginMs = 10 * 60 * 1000
const sharedReport = 'AUD-2001'

const args = process.argv.slice(2)
const detail = args.includes('--detail')
const apiArgument = args.find((arg) => !arg.startsWith('--'))
const api = `${(apiArgument ?? process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '')}/`

// needsPurge: 정리가 한 건도 일어나지 않으면 저절로 통과하는 묶음. 이때는 판정하지 않는다.
const groups = [
  { kind: 'trap', name: '336시간 지난 경계 건 정리', note: '"14일 초과"로 읽으면 놓친다', keys: ['attachment:INC-1002'] },
  { kind: 'trap', name: '336시간 안 된 경계 건 유지', note: '날짜 차이(14일)로 계산하면 놓친다', keys: ['attachment:INC-1003'], needsPurge: true },
  { kind: 'trap', name: '오래된 미처리 건 유지', note: '등록일로 판단하면 놓친다', keys: ['attachment:INC-1007'], needsPurge: true },
  { kind: 'trap', name: '법적 보존 건 유지', note: '정책 문서의 제외 규칙', keys: ['attachment:INC-1008'], needsPurge: true },
  { kind: 'trap', name: '보고서가 쓰는 파일 보존', note: '이벤트에서는 정리, 보고서에서는 다운로드', keys: ['attachment:INC-1006', 'report'], needsPurge: true },
  { kind: 'trap', name: '저장 공간 회수', note: '파일 저장소에서 실제로 삭제', keys: ['files'] },
  { kind: 'basic', name: '정리 API 실행', keys: ['run:1'] },
  { kind: 'basic', name: '기한 지난 건 정리', keys: ['attachment:INC-1004', 'attachment:INC-1005', 'attachment:INC-1012', 'attachment:INC-1015'] },
  { kind: 'basic', name: '기한 안 된 건 유지', keys: ['attachment:INC-1001', 'attachment:INC-1009', 'attachment:INC-1010', 'attachment:INC-1011', 'attachment:INC-1013', 'attachment:INC-1014'], needsPurge: true },
  { kind: 'basic', name: '정리해도 이벤트는 남김', keys: ['incident:'], needsPurge: true },
  { kind: 'basic', name: '다시 실행해도 결과 유지', rerun: true, needsPurge: true },
]

async function call(path, options) {
  const response = await fetch(new URL(path, api), { ...options, signal: AbortSignal.timeout(5000) })
  return response
}

async function status(path) {
  const response = await call(path)
  await response.arrayBuffer()
  return response.status
}

async function json(path) {
  const response = await call(path)
  if (!response.ok) throw new Error(`${path} 가 ${response.status} 를 반환했습니다.`)
  return response.json()
}

let incidents
try {
  incidents = await json('incidents')
} catch (error) {
  fail(`API 에 연결할 수 없습니다 (${api}): ${error instanceof Error ? error.message : error}`)
}

const now = Date.now()
const warnings = []
const byId = new Map(incidents.map((incident) => [incident.id, incident]))
const extra = incidents.filter((incident) => !fixtures.some((fixture) => fixture.id === incident.id))
if (extra.length) warnings.push(`seed 에 없는 이벤트 ${extra.length}건이 있습니다 (${extra.map(({ id }) => id).join(', ')}). 파일 수 기대값이 맞지 않을 수 있습니다.`)

const cases = fixtures.map((fixture) => {
  const incident = byId.get(fixture.id)
  if (!incident) return { fixture, missing: true }

  const closedAt = typeof incident.closedAt === 'string' ? Date.parse(incident.closedAt) : null
  const legalHold = incident.legalHold === true
  const elapsed = closedAt === null ? null : now - closedAt
  const purge = elapsed !== null && elapsed >= retentionMs && !legalHold
  if (elapsed !== null && Math.abs(elapsed - retentionMs) < boundaryMarginMs) {
    warnings.push(`${fixture.id} 가 336시간 경계에서 ${Math.round(Math.abs(elapsed - retentionMs) / 60000)}분 떨어져 있습니다. 결과가 실행 시각에 따라 달라질 수 있습니다.`)
  }
  if (purge !== fixture.expect.startsWith('purge')) {
    warnings.push(`${fixture.id} 의 현재 기대 결과(${purge ? '정리' : '유지'})가 fixtures 의 의도(${fixture.expect})와 다릅니다. seed 와 같은 날 00:30~23:30(KST)에 채점하세요.`)
  }
  return { fixture, purge, closedAt: incident.closedAt }
})

const expectedFiles = fixtures.length - cases.filter(({ fixture, purge }) => purge && !fixture.report).length

async function inspect() {
  const results = []
  for (const item of cases) {
    if (item.missing) {
      results.push({ key: `attachment:${item.fixture.id}`, name: `${item.fixture.id} 첨부`, pass: false, expected: '200', actual: '이벤트 없음' })
      continue
    }
    const code = await status(`incidents/${encodeURIComponent(item.fixture.id)}/attachment`)
    results.push({
      key: `attachment:${item.fixture.id}`,
      name: `${item.fixture.id} 첨부`,
      pass: item.purge ? code !== 200 : code === 200,
      expected: item.purge ? '200 아님' : '200',
      actual: String(code),
    })
    if (item.purge) {
      const incidentCode = await status(`incidents/${encodeURIComponent(item.fixture.id)}`)
      results.push({ key: `incident:${item.fixture.id}`, name: `${item.fixture.id} 이벤트`, pass: incidentCode === 200, expected: '200', actual: String(incidentCode) })
    }
  }

  const reportCode = await status(`audit-reports/${sharedReport}/attachment`)
  results.push({ key: 'report', name: `${sharedReport} 보고서 증빙`, pass: reportCode === 200, expected: '200', actual: String(reportCode) })

  let files = '조회 실패'
  try {
    files = (await json('storage/usage')).files
  } catch {}
  results.push({ key: 'files', name: '저장소 파일 수', pass: files === expectedFiles, expected: String(expectedFiles), actual: String(files) })
  return results
}

async function runRetention() {
  const response = await call('maintenance/retention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, text: text.slice(0, 200) }
}

const first = await runRetention()
const round1 = await inspect()
const second = await runRetention()
const round2 = await inspect()

const runCheck = (run, round) => ({ key: `run:${round}`, name: `정리 API ${round}회차`, pass: run.ok, expected: '2xx', actual: `${run.status}${run.ok ? '' : ` ${run.text}`}` })
const checks1 = [runCheck(first, 1), ...round1]
const checks2 = [runCheck(second, 2), ...round2]
const select = (checks, keys) => checks.filter(({ key }) => keys.some((prefix) => key === prefix || (prefix.endsWith(':') && key.startsWith(prefix))))
const purgedAny = round1.some((result) => result.key.startsWith('attachment:') && result.expected === '200 아님' && result.pass)
const describe = (result) => `${result.name}: 기대 ${result.expected}, 실제 ${result.actual}`

const verdicts = groups.map((group) => {
  if (group.needsPurge && !purgedAny) return { ...group, verdict: 'skip', reasons: ['정리된 첨부가 없어 판정하지 않음'] }
  if (group.rerun) {
    const broken = checks2.filter((result, index) => (result.key === 'run:2' || checks1[index].pass) && !result.pass)
    return { ...group, verdict: broken.length ? 'fail' : 'pass', reasons: broken.map(describe) }
  }
  const failed = select(checks1, group.keys).filter(({ pass }) => !pass)
  return { ...group, verdict: failed.length ? 'fail' : 'pass', reasons: failed.map(describe) }
})

const symbol = { pass: '✓', fail: '✗', skip: '–' }
const summary = (kind) => {
  const items = verdicts.filter((verdict) => verdict.kind === kind)
  const passed = items.filter(({ verdict }) => verdict === 'pass').length
  const skipped = items.filter(({ verdict }) => verdict === 'skip').length
  return `${items.length}개 중 ${passed}개 통과${skipped ? ` (판정 불가 ${skipped})` : ''}`
}

const out = (line = '') => process.stdout.write(`${line}\n`)
out(`채점 ${formatKst(new Date(now).toISOString())} (KST)  ${api}`)
out()
out(`함정 ${summary('trap')} · 기본 동작 ${summary('basic')}`)
for (const [kind, title] of [['trap', '함정'], ['basic', '기본 동작']]) {
  out()
  out(title)
  for (const verdict of verdicts.filter((item) => item.kind === kind)) {
    out(`  ${symbol[verdict.verdict]} ${verdict.name}${verdict.note ? `  (${verdict.note})` : ''}`)
    for (const reason of verdict.reasons) out(`      ${reason}`)
  }
}
out()
out('화면에서 직접 확인')
out('  · 정리된 이벤트 상세에 "보존기간 만료로 정리됨" 표시, 처음부터 첨부가 없는 경우와 구분')

if (detail) {
  const pad = (text, width) => {
    const length = [...String(text)].reduce((sum, character) => sum + (character.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
    return String(text) + ' '.repeat(Math.max(0, width - length))
  }
  const mark = (result) => `${result.pass ? 'PASS' : 'FAIL'} ${result.actual}`
  out()
  out(`${pad('항목', 22)}${pad('기대', 10)}${pad('1회차', 14)}2회차`)
  checks1.forEach((result, index) => out(`${pad(result.name, 22)}${pad(result.expected, 10)}${pad(mark(result), 14)}${mark(checks2[index])}`))
}

if (warnings.length) {
  out()
  out('경고')
  for (const warning of [...new Set(warnings)]) out(`- ${warning}`)
}
process.exitCode = verdicts.every(({ verdict }) => verdict === 'pass') ? 0 : 1
