// 사용법: node seed.mjs [API 주소]   (기본값 http://localhost:8080)
// 첨부 교체 과제용 데이터를 API 로 넣는다. API 를 거치므로 검색·미리보기·카운터·감사 로그·알림도 함께 채워진다.
// 빈 DB 에만 넣는다. 데이터가 있으면 reset 부터 한다.
import { fail } from './lib.mjs'

const api = `${(process.argv[2] ?? process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '')}/`

const log = (service, lines) => lines.map(([at, level, message]) => `2026-11-${at}  ${level.padEnd(5)}  ${service}  ${message}`).join('\n') + '\n'
const sharedAuthLog = log('auth-service', [
  ['18T23:40:02Z', 'INFO', 'token refresh started'],
  ['18T23:40:05Z', 'WARN', 'refresh endpoint slow (2100ms)'],
  ['18T23:40:09Z', 'ERROR', 'refresh token endpoint returned 503'],
])

// role: 교체 대상(A·B·C·E), 비교 대상(D), 배경 데이터(-)
const incidents = [
  { id: 'INC-2001', role: 'A', title: '결제 API 응답 지연', file: 'payments-gateway.log', content: log('payments-api', [
    ['19T00:10:00Z', 'INFO', 'request started'],
    ['19T00:10:03Z', 'ERROR', 'upstream response timeout after 3000ms'],
  ]) },
  { id: 'INC-2002', role: 'B', title: '정산 배치 재시도', file: 'settlement-batch.log', closed: true, report: 'AUD-3001', content: log('settlement', [
    ['18T21:00:00Z', 'INFO', 'batch settlement-daily started'],
    ['18T21:05:12Z', 'WARN', 'retry scheduled (attempt 2)'],
    ['18T21:09:40Z', 'ERROR', 'batch attempt exceeded timeout'],
  ]) },
  { id: 'INC-2003', role: 'C', title: '인증 토큰 갱신 실패', file: 'auth-refresh.log', content: sharedAuthLog },
  { id: 'INC-2004', role: 'D', title: '인증 서버 503 급증', file: 'auth-gateway.log', closed: true, content: sharedAuthLog },
  { id: 'INC-2005', role: 'E', title: '백업 작업 지연', file: 'backup-worker.log', content: log('backup-worker', [
    ['18T19:30:00Z', 'INFO', 'snapshot started'],
    ['18T19:52:44Z', 'WARN', 'snapshot queue exceeded threshold'],
  ]) },
  { id: 'INC-2006', role: '-', title: '알림 발송 큐 적체', file: 'notification-queue.log', closed: true, content: log('notification-worker', [
    ['17T08:00:00Z', 'WARN', 'queue depth exceeded 50000 messages'],
  ]) },
  { id: 'INC-2007', role: '-', title: '검색 인덱스 재구축 실패', file: 'search-reindex.log', closed: true, report: 'AUD-3002', content: log('search-indexer', [
    ['16T02:15:00Z', 'ERROR', 'shard allocation failed on node search-2'],
  ]) },
  { id: 'INC-2008', role: '-', title: '로그 수집기 디스크 경고', file: 'log-collector-disk.log', content: log('log-collector', [
    ['18T11:20:00Z', 'WARN', 'disk usage reached 92% on /var/lib/collector'],
  ]) },
  { id: 'INC-2009', role: '-', title: 'CDN 캐시 무효화 지연', file: 'cdn-purge.log', content: log('cdn-purger', [
    ['19T01:02:00Z', 'WARN', 'invalidation pending for 1240s'],
  ]) },
  { id: 'INC-2010', role: '-', title: '메일 서버 인증 오류', file: 'mail-relay.log', closed: true, content: log('mail-relay', [
    ['15T09:05:00Z', 'ERROR', 'SMTP AUTH failed for relay account'],
  ]) },
]

// 외부 공유. A 와 D 를 서로 다른 사람에게 공유한다 (레거시 API).
const shares = [
  { incidentId: 'INC-2001', grantee: 'auditor@partner.example' },
  { incidentId: 'INC-2004', grantee: 'reviewer@partner.example' },
]

// 교체 대상 E 가 들어간 작업은 실행하지 않고 대기 상태로 둔다. 다른 작업은 미리 실행해 둔다.
const exportsToCreate = [
  { incidentIds: ['INC-2006', 'INC-2007'], run: true },
  { incidentIds: ['INC-2005', 'INC-2008'], run: false },
]

async function call(method, path, body) {
  const response = await fetch(new URL(path, api), {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

try {
  const existing = await call('GET', 'incidents')
  if (existing.length) fail(`이벤트가 ${existing.length}건 있습니다. 서버를 끄고 reset 한 뒤 다시 실행하세요.`)

  const fileIds = {}
  for (const incident of incidents) {
    const created = await call('POST', 'incidents', { id: incident.id, title: incident.title, attachment: { name: incident.file, content: incident.content } })
    fileIds[incident.id] = created.attachmentId
  }
  for (const incident of incidents.filter(({ report }) => report)) {
    await call('POST', 'audit-reports', { id: incident.report, incidentId: incident.id, attachmentId: fileIds[incident.id] })
  }
  for (const incident of incidents.filter(({ closed }) => closed)) {
    await call('POST', `incidents/${incident.id}/close`, {})
  }
  const jobs = []
  for (const job of exportsToCreate) {
    const created = await call('POST', 'exports', { incidentIds: job.incidentIds })
    if (job.run) await call('POST', `exports/${created.id}/run`, {})
    jobs.push({ id: created.id, incidentIds: job.incidentIds, run: job.run })
  }

  for (const share of shares) {
    const result = await call('POST', 'legacy/share', share)
    if (result.result !== 'OK') throw new Error(`공유 실패 ${share.incidentId}: ${result.message}`)
  }
  const archived = await call('POST', 'legacy/archive/run', {})
  if (archived.result !== 'OK') throw new Error(`장기 보관 실패: ${archived.message}`)

  const usage = await call('GET', 'storage/usage')
  process.stdout.write(`이벤트 ${incidents.length}건, 보고서 ${incidents.filter(({ report }) => report).length}건, 내보내기 작업 ${jobs.length}건을 넣었습니다. 파일 ${usage.files}개\n\n`)
  for (const incident of incidents.filter(({ role }) => role !== '-')) {
    process.stdout.write(`${incident.role}  ${incident.id}  ${incident.file}${incident.report ? `  보고서 ${incident.report}` : ''}\n`)
  }
  for (const job of jobs) process.stdout.write(`내보내기 ${job.id}  ${job.incidentIds.join(', ')}  ${job.run ? '실행 완료' : '대기'}\n`)
  for (const share of shares) process.stdout.write(`공유 ${share.incidentId} → ${share.grantee}\n`)
  process.stdout.write(`장기 보관 ${archived.data.archived.length}건\n`)
} catch (error) {
  fail(error)
}
