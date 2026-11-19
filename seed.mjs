// 사용법: node seed.mjs <프로젝트 경로> [--date YYYY-MM-DD]
// 프로젝트 경로는 ai-agent-study/app 이다.
// 기준일 기본값은 오늘(KST)이다. 정리 기능은 실제 현재 시각으로 판단하므로 seed 와 채점은 같은 날 한다.
// 앱 서버를 한 번 이상 실행해 DB 가 준비돼 있어야 하고, file-store 가 실행 중이어야 한다.
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fixtures } from './fixtures.mjs'
import { fail, formatKst, isListening, kstTimestamp, parseBaseDate, requireDirectory, todayKst } from './lib.mjs'

const schemaVersion = 3

const args = process.argv.slice(2)
const dateIndex = args.indexOf('--date')
const dateArgument = dateIndex === -1 ? undefined : args.splice(dateIndex, 2)[1]
const [projectArgument] = args
if (!projectArgument) fail('사용법: node seed.mjs <프로젝트 경로> [--date YYYY-MM-DD]')

const project = resolve(projectArgument)
const today = todayKst()
const baseDate = dateArgument ?? today
let base
try {
  requireDirectory(project, 'server/index.ts', '앱 프로젝트')
  base = parseBaseDate(baseDate)
} catch (error) {
  fail(error)
}

const databasePath = join(resolve(project, process.env.DEMO_DATA_DIR ?? '.data/evidence'), 'metadata.sqlite')
const storeBase = `${(process.env.FILE_STORE_URL ?? 'http://localhost:6006').replace(/\/+$/, '')}/`
const space = process.env.FILE_STORE_SPACE ?? basename(project)
const filesUrl = new URL(`spaces/${space}/files`, storeBase)

if (!await isListening(new URL('health', storeBase))) {
  fail(`file-store 에 연결할 수 없습니다 (${storeBase}). 먼저 서버를 실행하세요.`)
}
if (!existsSync(databasePath)) {
  fail(`DB 가 없습니다: ${databasePath}\n앱 서버를 한 번 실행해 DB 를 만든 뒤 다시 실행하세요.`)
}

const database = new DatabaseSync(databasePath)
database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000')

const version = database.prepare('PRAGMA user_version').get()?.user_version
if (version !== schemaVersion) {
  fail(`DB 스키마 버전이 ${version} 입니다. seed 는 버전 ${schemaVersion} 을 기준으로 합니다. reset 후 원래 코드로 서버를 실행해 DB 를 다시 만드세요.`)
}
const { count } = database.prepare('SELECT count(*) AS count FROM incidents').get()
if (count !== 0) fail(`DB 에 이벤트가 ${count}건 있습니다. reset 으로 초기화한 뒤 seed 하세요.`)

const rows = fixtures.map((fixture) => {
  const createdAt = kstTimestamp(base, fixture.created)
  const closedAt = fixture.closed ? kstTimestamp(base, fixture.closed) : null
  const content = [
    `${createdAt}  INFO   ${fixture.service}  request started`,
    `${createdAt}  WARN   ${fixture.service}  retry scheduled`,
    `${createdAt}  ERROR  ${fixture.service}  ${fixture.message}`,
    '',
  ].join('\n')
  return { ...fixture, createdAt, closedAt, content }
})

async function upload(name, content) {
  const response = await fetch(filesUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    body: Buffer.from(content, 'utf8'),
    signal: AbortSignal.timeout(3000),
  })
  if (response.status !== 201) throw new Error(`file-store 업로드 실패 (${response.status}): ${name}`)
  const { id } = await response.json()
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error(`file-store 응답이 올바르지 않습니다: ${name}`)
  return id
}

async function remove(id) {
  await fetch(new URL(`${filesUrl.pathname}/${id}`, storeBase), { method: 'DELETE', signal: AbortSignal.timeout(3000) }).catch(() => {})
}

const uploaded = []
try {
  for (const row of rows) {
    row.fileId = await upload(row.file, row.content)
    uploaded.push(row.fileId)
  }

  const insertIncident = database.prepare('INSERT INTO incidents (id, title, created_at, closed_at, legal_hold) VALUES (?, ?, ?, ?, ?)')
  const insertAttachment = database.prepare('INSERT INTO incident_attachments (incident_id, name, file_id) VALUES (?, ?, ?)')
  const insertReport = database.prepare('INSERT INTO reports (id, name, file_id, source_incident_id) VALUES (?, ?, ?, ?)')
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      insertIncident.run(row.id, row.title, row.createdAt, row.closedAt, row.legalHold ? 1 : 0)
      insertAttachment.run(row.id, row.file, row.fileId)
      if (row.report) insertReport.run(row.report, row.file, row.fileId, row.id)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
} catch (error) {
  await Promise.all(uploaded.map(remove))
  fail(error)
} finally {
  database.close()
}

process.stdout.write(`${basename(project)} 에 이벤트 ${rows.length}건, 보고서 ${rows.filter((row) => row.report).length}건을 넣었습니다. 기준일 ${baseDate} (KST)\n\n`)
for (const row of rows) {
  const flags = [row.legalHold && 'legal hold', row.report && `보고서 ${row.report}`].filter(Boolean).join(', ')
  process.stdout.write(`${row.id}  ${row.closedAt ? `처리 완료 ${formatKst(row.closedAt)}` : `미처리   ${formatKst(row.createdAt)} 등록`}  ${row.expect.padEnd(15)}  ${flags}\n`)
}
if (baseDate !== today) {
  process.stdout.write(`\n주의: 기준일(${baseDate})이 오늘(${today})과 다릅니다. 정리 기능은 실제 현재 시각으로 판단하므로 기대 결과가 달라집니다.\n`)
}
