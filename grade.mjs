// 사용법: node grade.mjs [API 주소]   (기본값 http://localhost:8080)
// 첨부 교체 과제를 HTTP 응답만 보고 채점한다. 코드와 DB 는 보지 않는다.
// seed 직후 상태에서 한 번만 실행한다. A·B·C·E 를 실제로 교체하므로, 다시 채점하려면 reset 과 seed 부터 한다.
// 기준은 design/answer-key.md 의 E1~E16 이다.
import { fail, formatKst } from './lib.mjs'

const api = `${(process.argv[2] ?? process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '')}/`

const SEED = {
  'INC-2001': 'payments-gateway.log',
  'INC-2002': 'settlement-batch.log',
  'INC-2003': 'auth-refresh.log',
  'INC-2004': 'auth-gateway.log',
  'INC-2005': 'backup-worker.log',
}
const REPLACE = {
  A: { id: 'INC-2001', name: 'payments-gateway-v2.log', content: 'REPLACED-A payments rollback complete' },
  B: { id: 'INC-2002', name: 'settlement-batch-v2.log', content: 'REPLACED-B settlement rerun ok' },
  C: { id: 'INC-2003', name: 'auth-refresh-v2.log', content: 'REPLACED-C auth fixed' },
  E: { id: 'INC-2005', name: 'backup-worker-v2.log', content: 'REPLACED-E backup recovered' },
}
const REPORT = 'AUD-3001'
const AUDITOR = 'auditor@partner.example'
const REVIEWER = 'reviewer@partner.example'
const CORE_PREFIX = 'INC-200'

async function call(method, path, body) {
  try {
    const response = await fetch(new URL(path, api), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    const text = buffer.toString('utf8')
    let json
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: response.status, text, json, bytes: buffer.length, disposition: response.headers.get('content-disposition') || '' }
  } catch (error) {
    return { status: 0, text: `요청 실패: ${error instanceof Error ? error.message : error}`, bytes: 0, disposition: '' }
  }
}

const get = (path) => call('GET', path)
const enc = encodeURIComponent
const short = (value) => String(value ?? '').replace(/\s+/g, ' ').slice(0, 70)
const results = []
function record(id, title, verdict, reason) {
  results.push({ id, title, verdict, reason })
}

// ─── 0. seed 상태 확인 ──────────────────────────────────────────────────────

const incidents = await get('incidents')
if (!Array.isArray(incidents.json)) fail(`API 에 연결할 수 없습니다 (${api}): ${incidents.status} ${short(incidents.text)}`)
const byId = new Map(incidents.json.map((incident) => [incident.id, incident]))
for (const [id, name] of Object.entries(SEED)) {
  const incident = byId.get(id)
  if (!incident?.attachment) fail(`${id} 가 없거나 첨부가 없습니다. reset 과 seed 를 다시 하세요.`)
  if (incident.attachment.name !== name) fail(`${id} 의 첨부가 seed 와 다릅니다 (${incident.attachment.name}). 이미 교체된 상태입니다. reset 과 seed 를 다시 하세요.`)
}
const warnings = []
const archived = await get('v3/archive')
if (!Array.isArray(archived.json) || archived.json.length < 10) warnings.push('장기 보관본이 seed 보다 적습니다. seed 마지막의 보관 실행이 빠졌을 수 있습니다.')
const shareA = await get(`v3/shared/${AUDITOR}/INC-2001`)
if (shareA.status !== 200) warnings.push(`A 공유가 seed 상태가 아닙니다 (${shareA.status}).`)

// ─── 1. 교체 전 기준값 ──────────────────────────────────────────────────────

const old = {}
for (const [key, target] of Object.entries(REPLACE)) {
  const fileId = byId.get(target.id).attachment.id
  const blob = await get(`v1/blobs/${fileId}`)
  old[key] = { fileId, content: blob.text, bytes: blob.bytes }
}
const dBefore = await get('incidents/INC-2004/attachment')
const exportJob = (await get('exports')).json?.find((job) => job.status === 'queued' && job.items.some((item) => item.caseNo === 'INC-2005'))
if (!exportJob) warnings.push('INC-2005 가 들어 있는 대기 중인 내보내기 작업이 없습니다.')
await get('incidents/INC-2001/preview')
await get('v3/billing/usage/core')
const stats0 = (await get('stats')).json
const audit0 = (await get('audit-log?subject=INC-2001&limit=1000')).json?.length ?? 0
const outbox0 = (await get('notifications/outbox')).json?.filter((message) => message.payload?.caseNo === 'INC-2001').length ?? 0

// ─── 2. 교체 ────────────────────────────────────────────────────────────────

const puts = {}
for (const [key, target] of Object.entries(REPLACE)) {
  puts[key] = await call('PUT', `incidents/${target.id}/attachment`, { name: target.name, content: target.content })
}
const newA = (await get('incidents/INC-2001')).json?.attachment?.id
const failedPuts = Object.entries(puts).filter(([, response]) => response.status !== 200)

// ─── 3. 채점 ────────────────────────────────────────────────────────────────

// E1
{
  const download = await get('incidents/INC-2001/attachment')
  const ok = puts.A.status === 200 && puts.A.json?.attachment?.name === REPLACE.A.name
    && download.status === 200 && download.text === REPLACE.A.content && download.disposition.includes(enc(REPLACE.A.name))
  record('E1', 'v2 첨부 다운로드', ok ? 'pass' : 'fail', ok ? '새 이름·새 내용' : `PUT ${puts.A.status}, 다운로드 ${download.status} ${short(download.text)}`)
}
// E2
{
  const v1 = await get('v1/evidence/INC-2001/content')
  const ok = v1.status === 200 && v1.text === REPLACE.A.content
  record('E2', 'v1 첨부 다운로드', ok ? 'pass' : 'fail', ok ? '새 내용' : `${v1.status} ${short(v1.text)}`)
}

const deleted = {}
for (const key of Object.keys(REPLACE)) deleted[key] = (await get(`v1/blobs/${old[key].fileId}`)).status === 404
const deletedAny = Object.values(deleted).some(Boolean)
const trivialNote = '옛 파일을 하나도 지우지 않아 판정하지 않음'

// E3
{
  const report = await get(`audit-reports/${REPORT}/attachment`)
  const ok = report.status === 200 && report.text === old.B.content
  record('E3', '보고서 증빙 유지', !deletedAny ? 'skip' : ok ? 'pass' : 'fail', !deletedAny ? trivialNote : ok ? '옛 내용 그대로' : `${report.status} ${short(report.text)}`)
}
// E4
{
  const d = await get('incidents/INC-2004/attachment')
  const ok = d.status === 200 && d.text === dBefore.text
  record('E4', '같은 파일을 쓰던 D', !deletedAny ? 'skip' : ok ? 'pass' : 'fail', !deletedAny ? trivialNote : ok ? 'D 그대로' : `${d.status} ${short(d.text)}`)
}
// E5
if (!exportJob) {
  record('E5', '대기 중인 내보내기', 'skip', '대기 중인 작업이 없음')
} else {
  const run = await call('POST', `exports/${exportJob.id}/run`, {})
  const bundle = await get(`exports/${exportJob.id}/bundle`)
  const ok = run.json?.status === 'completed' && bundle.status === 200 && bundle.text.includes(old.E.content.trim())
  record('E5', '대기 중인 내보내기', !deletedAny ? 'skip' : ok ? 'pass' : 'fail',
    !deletedAny ? trivialNote : ok ? '실행 성공, 옛 내용 포함' : `${run.json?.status ?? run.status} ${short(run.json?.result?.error)}`)
}
// E6
record('E6', '참조 없는 옛 파일 삭제', deleted.A ? 'pass' : 'fail', deleted.A ? 'A 의 옛 파일 404' : 'A 의 옛 파일이 남아 있음')
// E7
{
  const fresh = (await get(`search?q=${enc(REPLACE.A.name)}`)).json || []
  const oldName = (await get(`search?q=${enc(SEED['INC-2001'])}`)).json || []
  const oldBody = (await get('search?q=upstream')).json || []
  const ok = fresh.some((row) => row.incidentId === 'INC-2001') && !oldName.some((row) => row.incidentId === 'INC-2001') && !oldBody.some((row) => row.incidentId === 'INC-2001')
  record('E7', '검색', ok ? 'pass' : 'fail', ok ? '새 이름으로만 검색됨' : `새 이름 ${fresh.length}건, 옛 이름 A ${oldName.filter((row) => row.incidentId === 'INC-2001').length}건, 옛 본문 A ${oldBody.filter((row) => row.incidentId === 'INC-2001').length}건`)
}
// E8
{
  const preview = (await get('incidents/INC-2001/preview')).json
  const ok = preview?.name === REPLACE.A.name && String(preview?.body).startsWith(REPLACE.A.content)
  record('E8', '미리보기', ok ? 'pass' : 'fail', ok ? '새 내용' : `${preview?.name} | ${short(preview?.body)}`)
}
// E9
{
  const stats = (await get('stats')).json
  const delta = Object.keys(REPLACE).reduce((sum, key) => sum + Buffer.byteLength(REPLACE[key].content) - old[key].bytes, 0)
  const expected = stats0.attachmentBytes + delta
  const ok = stats?.attachmentCount === stats0.attachmentCount && stats?.attachmentBytes === expected
  record('E9', '대시보드 카운터', ok ? 'pass' : 'fail', `수 ${stats0.attachmentCount}→${stats?.attachmentCount}, 바이트 ${stats0.attachmentBytes}→${stats?.attachmentBytes} (기대 ${expected})`)
}
// E10
{
  const entries = (await get('audit-log?subject=INC-2001&limit=1000')).json || []
  const added = entries.slice(0, Math.max(0, entries.length - audit0))
  const withNew = added.filter((entry) => JSON.stringify(entry).includes(newA))
  const withBoth = withNew.filter((entry) => JSON.stringify(entry).includes(old.A.fileId))
  const verdict = withBoth.length ? 'pass' : withNew.length ? 'partial' : 'fail'
  record('E10', '감사 로그', verdict, verdict === 'pass' ? '교체 기록에 옛·새 ID' : verdict === 'partial' ? '새 ID 기록, 옛 ID 없음' : '교체 기록 없음')
}
// E11
{
  const messages = (await get('notifications/outbox')).json?.filter((message) => message.payload?.caseNo === 'INC-2001') || []
  const added = messages.slice(0, Math.max(0, messages.length - outbox0))
  const ok = added.some((message) => JSON.stringify(message.payload).includes(newA))
  record('E11', '알림 대기열', ok ? 'pass' : 'fail', ok ? '새 ID 알림' : `추가된 알림 ${added.length}건`)
}
// E12
{
  const missing = await call('PUT', 'incidents/NOPE-404/attachment', { name: 'x.log', content: 'x' })
  record('E12', '없는 이벤트 교체', missing.status === 404 ? 'pass' : 'fail', `${missing.status}`)
}
// E13
{
  const a = await get(`v3/shared/${AUDITOR}/INC-2001`)
  const d = await get(`v3/shared/${REVIEWER}/INC-2004`)
  const ok = a.status === 200 && a.text === REPLACE.A.content && d.status === 200 && d.text === dBefore.text
  record('E13', '공유 권한', ok ? 'pass' : 'fail', `A 공유자 ${a.status}${a.status === 200 ? (a.text === REPLACE.A.content ? ' 새 내용' : ' 옛 내용') : ''}, D 공유자 ${d.status}`)
}
// E14
{
  const current = (await get('incidents')).json || []
  const files = [...new Set(current.filter((incident) => incident.id.startsWith(CORE_PREFIX) && incident.attachment).map((incident) => incident.attachment.id))]
  let expected = 0
  for (const fileId of files) expected += (await get(`v1/blobs/${fileId}`)).bytes
  const usage = (await get('v3/billing/usage/core')).json
  const ok = usage?.usedBytes === expected
  record('E14', '팀 용량 장부', ok ? 'pass' : 'fail', `core ${usage?.usedBytes} 바이트·장부 ${usage?.entries}건 (기대 ${expected} 바이트·${files.length}건)`)
}
// E15
{
  const run = await call('POST', 'legacy/archive/run', {})
  const copy = await get('v3/archive/INC-2001')
  const ok = copy.status === 200 && copy.text === REPLACE.A.content
  record('E15', '장기 보관', ok ? 'pass' : 'fail', ok ? '새 내용으로 보관' : `보관 실행 ${run.json?.result ?? run.status}, 보관본 ${short(copy.text)}`)
}
// E16
{
  const received = (await get('v3/webhook-sink?caseNo=INC-2001')).json || []
  const latest = received[0]
  const ok = latest?.sigRef === newA && latest?.verified === true
  record('E16', '웹훅', ok ? 'pass' : 'fail', ok ? '새 해시, 서명 검증 통과' : `최신 ${String(latest?.sigRef).slice(0, 10)} verified=${latest?.verified}`)
}

// 교체 요청이 실패하면 "바뀌지 않았으니 기대값과 같다" 로 통과하는 항목이 생긴다. 교체 결과를 보는 항목은 실패로 바꾼다.
if (failedPuts.length) {
  const reason = `교체 요청 실패 (${failedPuts.map(([key, response]) => `${key} ${response.status}`).join(', ')})`
  for (const result of results) if (result.id !== 'E12' && result.verdict !== 'fail') Object.assign(result, { verdict: 'fail', reason })
}

// ─── 4. 출력 ────────────────────────────────────────────────────────────────

const symbol = { pass: '✓', fail: '✗', partial: '△', skip: '–' }
const count = (verdict) => results.filter((result) => result.verdict === verdict).length
const out = (line = '') => process.stdout.write(`${line}\n`)
out(`채점 ${formatKst(new Date().toISOString())} (KST)  ${api}`)
out()
out(`16개 중 ${count('pass')}개 통과${count('partial') ? ` · 부분 ${count('partial')}` : ''}${count('skip') ? ` · 판정 불가 ${count('skip')}` : ''}`)
out()
for (const { id, title, verdict, reason } of results) out(`  ${symbol[verdict]} ${id.padEnd(4)} ${title}  —  ${reason}`)
if (warnings.length) {
  out()
  out('경고')
  for (const warning of warnings) out(`- ${warning}`)
}
process.exitCode = results.every((result) => result.verdict === 'pass') ? 0 : 1
