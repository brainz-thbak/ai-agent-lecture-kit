#!/usr/bin/env node
// 피드백 루프 상태 전이기. 노드 이동은 이 스크립트로만 한다.
// 전이 조건을 확인하지 못하면 상태를 바꾸지 않고 종료 코드 2 와 사유를 출력한다.
//
//   node transition.mjs init <task_id> [--dir <작업 폴더>]
//   node transition.mjs status --dir <작업 폴더>
//   node transition.mjs move <다음 노드> --dir <작업 폴더> [--evidence <파일>] [--reason <사유>] [--replace-implementer <사유>]
//
// 작업 폴더 기본값은 현재 디렉터리의 .feedback/<task_id> 다.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const EDGES = {
  refine: ['analyze'],
  analyze: ['requirementsGate', 'incomplete'],
  requirementsGate: ['cases', 'revise', 'clarify'],
  revise: ['refine'],
  clarify: ['refine', 'incomplete'],
  cases: ['implement'],
  implement: ['verify', 'incomplete'],
  verify: ['verificationGate', 'incomplete'],
  verificationGate: ['done', 'feedback', 'resolve'],
  feedback: ['implement', 'incomplete'],
  resolve: ['verify', 'refine', 'incomplete'],
  done: [],
  incomplete: [],
}

const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u

class TransitionError extends Error {}

function reject(message) {
  throw new TransitionError(message)
}

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value.startsWith('--')) {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) reject(`${value} 에 값이 필요합니다.`)
      options[value.slice(2)] = next
      index += 1
    } else {
      positional.push(value)
    }
  }
  return { positional, options }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readText(path) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
  } catch {
    reject(`UTF-8 텍스트 파일로 읽을 수 없습니다: ${path}`)
  }
}

function readJson(path) {
  try {
    return JSON.parse(readText(path))
  } catch (error) {
    if (error instanceof TransitionError) throw error
    reject(`JSON 으로 읽을 수 없습니다: ${path}`)
  }
}

function now() {
  return new Date().toISOString()
}

// ─── 상태 파일 ──────────────────────────────────────────────────────────────

function statePath(dir) {
  return join(dir, 'state.json')
}

function loadState(dirOption) {
  if (!dirOption) reject('--dir <작업 폴더> 가 필요합니다. init 이 출력한 경로를 사용하세요.')
  const dir = resolve(dirOption)
  if (!existsSync(statePath(dir))) reject(`상태 파일이 없습니다: ${statePath(dir)}. 먼저 init 을 실행하세요.`)
  return readJson(statePath(dir))
}

function saveState(state, entry) {
  state.updated_at = now()
  writeFileSync(statePath(state.dir), `${JSON.stringify(state, null, 2)}\n`)
  appendFileSync(join(state.dir, 'transitions.log'), `${JSON.stringify(entry)}\n`)
}

function evidencePath(state, option, label) {
  if (!option) reject(`${label} 파일을 --evidence 로 전달해야 합니다.`)
  const path = resolve(option)
  if (!existsSync(path) || !statSync(path).isFile()) reject(`${label} 파일이 없습니다: ${path}`)
  const real = realpathSync(path)
  const root = realpathSync(state.dir)
  if (real !== root && !real.startsWith(root + sep)) reject(`${label} 파일은 작업 폴더 안에 있어야 합니다: ${state.dir}`)
  if (state.consumed.includes(real)) reject(`이미 다른 전이의 근거로 쓴 파일입니다: ${real}. 새 응답은 새 파일로 저장하세요.`)
  return real
}

// ─── 요구사항·케이스 ────────────────────────────────────────────────────────

function readRequirements(state) {
  const path = state.requirements_file
  if (!existsSync(path)) reject(`요구사항 파일이 없습니다: ${path}`)
  const lines = readText(path).split(/\r?\n/)
  const headerEnd = lines.findIndex((line, index) => index > 0 && line === '---')
  if (lines[0] !== '---' || headerEnd < 0) reject('요구사항 파일 맨 위에 task_id 를 담은 front matter 가 필요합니다.')
  const entries = lines.slice(1, headerEnd).filter((line) => /^task_id[ \t]*:/.test(line))
  if (entries.length !== 1) reject('요구사항 front matter 에 task_id 가 정확히 한 번 있어야 합니다.')
  const raw = entries[0].slice(entries[0].indexOf(':') + 1).trim()
  const taskId = raw.match(/^(['"])(.*)\1$/)?.[2] ?? raw
  if (taskId !== state.task_id) reject(`요구사항의 task_id(${taskId})가 작업 ID(${state.task_id})와 다릅니다.`)
  const body = lines.slice(headerEnd + 1).join('\n')
  const criteria = [...new Set(body.match(/\bAC-\d+\b/g) || [])]
  if (!criteria.length) reject('요구사항에 AC-01 형식의 수용 기준이 하나 이상 있어야 합니다.')
  return { hash: sha256(path), criteria, commands: readCommands(lines.slice(headerEnd + 1)) }
}

// "## 검증 명령" 절의 목록 항목마다 백틱으로 감싼 명령 하나를 읽는다. 실행 위치는 백틱 밖에 적는다.
// 명령이 없으면 그 이유를 적은 항목이 있어야 한다.
function readCommands(lines) {
  const start = lines.findIndex((line) => /^##\s*검증 명령\s*$/.test(line))
  if (start < 0) reject('요구사항에 "## 검증 명령" 절이 필요합니다. 빌드·타입 검사·테스트 명령을 적거나, 없으면 그 이유를 적으세요.')
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line))
  const items = lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => /^\s*[-*]\s+\S/.test(line))
  if (!items.length) reject('"## 검증 명령" 절이 비어 있습니다. 명령을 목록으로 적거나, 없으면 그 이유를 한 줄로 적으세요.')
  const commands = []
  for (const line of items) {
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim())
    if (spans.length > 1) reject(`검증 명령 항목에는 백틱으로 감싼 명령이 하나만 있어야 합니다: ${line.trim()}\n실행 위치는 백틱 밖에 적으세요. 예: - \`npx tsc --noEmit -p .\` (app 에서)`)
    if (spans.length === 1 && !commands.includes(spans[0])) commands.push(spans[0])
  }
  return commands
}

function requireUnchanged(state, label) {
  if (sha256(state.requirements_file) !== state.requirements_hash) {
    reject(`${label}: 요구사항 파일이 분석 이후 바뀌었습니다. refine 부터 다시 진행하세요.`)
  }
  if (state.cases_hash && sha256(state.cases_file) !== state.cases_hash) {
    reject(`${label}: 확정 케이스 파일이 바뀌었습니다. 확정 케이스는 구현과 검증 중에 수정하지 않습니다.`)
  }
}

// 파일 맨 위 --- 사이의 "키: 값" 줄을 읽는다.
function frontMatter(text) {
  const lines = text.split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && line === '---')
  if (lines[0] !== '---' || end < 0) return {}
  const values = {}
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/)
    if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

function caseIds(text) {
  return [...new Set(text.match(/\bCASE-\d+\b/g) || [])]
}

// ─── 응답 형식 확인 ─────────────────────────────────────────────────────────

// 기대 결과를 확정하지 않고 판단을 미루는 표현. 이런 기대 결과로는 검증에서 실패를 판정할 수 없다.
const HEDGES = [
  '정책에 따라', '정책에 맞게', '요구된 정책', '정한 정책', '보존 정책에 따라',
  '적절히', '적절하게', '일관되게', '필요한 경우', '필요한 소비자', '필요에 따라', '상황에 따라', '정책대로',
  'as appropriate', 'according to policy', 'per policy', 'if required', 'as needed',
]

function hedgesIn(text) {
  const lower = String(text || '').toLowerCase()
  return HEDGES.filter((phrase) => lower.includes(phrase.toLowerCase()))
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function checkAnalysis(state, analysis) {
  const problems = []
  if (analysis.task_id !== state.task_id) problems.push(`task_id 가 ${state.task_id} 가 아닙니다.`)
  if (analysis.requirements_hash !== state.requirements_hash) problems.push('requirements_hash 가 현재 요구사항 파일과 다릅니다. 현재 요구사항으로 다시 분석하세요.')
  if (!['PASS', 'REVISE', 'BLOCKED'].includes(analysis.status)) problems.push('status 는 PASS, REVISE, BLOCKED 중 하나여야 합니다.')
  for (const key of ['coverage', 'consumers', 'regression_candidates', 'issues']) {
    if (!Array.isArray(analysis[key])) problems.push(`${key} 배열이 필요합니다.`)
  }
  if (problems.length) return problems

  const candidateIds = new Set(analysis.regression_candidates.map((candidate) => candidate.id))
  for (const consumer of analysis.consumers) {
    const linked = Array.isArray(consumer.candidate_ids) && consumer.candidate_ids.length > 0
    if (!nonEmptyText(consumer.resource) || !nonEmptyText(consumer.consumer) || !nonEmptyText(consumer.source)) {
      problems.push('consumers 항목마다 resource, consumer, source 가 필요합니다.')
    }
    if (!linked && !nonEmptyText(consumer.rationale)) {
      problems.push(`사용처 ${consumer.consumer ?? '(이름 없음)'} 는 회귀 후보에 연결하거나 영향이 없는 근거(rationale)를 적어야 합니다.`)
    }
    for (const id of consumer.candidate_ids || []) if (!candidateIds.has(id)) problems.push(`consumers 가 없는 후보 ${id} 를 가리킵니다.`)
  }

  for (const candidate of analysis.regression_candidates) {
    const found = hedgesIn(candidate.verification?.expected_result)
    if (found.length) {
      problems.push(`후보 ${candidate.id} 의 기대 결과가 판단을 미룹니다 (${found.join(', ')}). 관찰할 값을 적거나, 요구사항만으로 정할 수 없으면 REQUESTER_DECISION 이슈로 올리고 BLOCKED 로 판정하세요.`)
    }
  }

  if (analysis.status === 'PASS') {
    if (!analysis.coverage.length) problems.push('PASS 에는 수용 기준별 coverage 가 필요합니다.')
    if (analysis.coverage.some((entry) => entry.assessment === 'UNDETERMINED')) problems.push('PASS 에는 UNDETERMINED 인 기준이 없어야 합니다.')
    if (analysis.issues.length) problems.push('PASS 에는 issues 가 없어야 합니다.')
    for (const candidate of analysis.regression_candidates) {
      if (!candidate.verification || typeof candidate.verification !== 'object') problems.push(`PASS 의 후보 ${candidate.id} 에 확인 방법(verification)이 필요합니다.`)
    }
    const requirements = readRequirements(state)
    const covered = new Set(analysis.coverage.map((entry) => entry.criterion_id))
    for (const id of requirements.criteria) if (!covered.has(id)) problems.push(`수용 기준 ${id} 의 coverage 가 없습니다.`)
  }
  if (analysis.status === 'REVISE' && !analysis.issues.some((issue) => issue.kind === 'REQUIREMENT_GAP')) {
    problems.push('REVISE 에는 REQUIREMENT_GAP 이슈가 하나 이상 필요합니다.')
  }
  if (analysis.status === 'BLOCKED' && !analysis.issues.some((issue) => ['REQUESTER_DECISION', 'MISSING_EVIDENCE'].includes(issue.kind))) {
    problems.push('BLOCKED 에는 REQUESTER_DECISION 또는 MISSING_EVIDENCE 이슈가 필요합니다.')
  }
  return problems
}

function checkVerification(state, verification) {
  const problems = []
  if (verification.task_id !== state.task_id) problems.push(`task_id 가 ${state.task_id} 가 아닙니다.`)
  let reportedFile = null
  try {
    reportedFile = verification.requirements_file ? realpathSync(resolve(verification.requirements_file)) : null
  } catch {}
  if (reportedFile !== realpathSync(state.requirements_file)) problems.push(`requirements_file 이 ${state.requirements_file} 가 아닙니다.`)
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(verification.status)) problems.push('status 는 PASS, FAIL, BLOCKED 중 하나여야 합니다.')
  if (!Array.isArray(verification.results)) problems.push('results 배열이 필요합니다.')
  if (!Array.isArray(verification.commands)) problems.push('commands 배열이 필요합니다. 실행한 검증 명령과 종료 코드를 적으세요.')
  if (problems.length) return problems

  const runs = new Map(verification.commands.map((run) => [String(run.command ?? '').trim(), run]))
  for (const command of state.commands || []) {
    const run = runs.get(command)
    if (verification.status === 'PASS') {
      if (!run) problems.push(`PASS 인데 검증 명령 \`${command}\` 의 실행 기록이 없습니다. 실행하지 못했다면 BLOCKED 로 보고하세요.`)
      else if (run.exit_code !== 0) problems.push(`PASS 인데 검증 명령 \`${command}\` 의 종료 코드가 ${run.exit_code} 입니다.`)
    }
  }

  const reported = new Map(verification.results.map((result) => [result.id, result]))
  if (verification.status === 'PASS') {
    for (const id of state.case_ids) {
      const result = reported.get(id)
      if (!result) problems.push(`확정 케이스 ${id} 의 결과가 없습니다.`)
      else if (result.required !== false && result.status !== 'PASS') problems.push(`PASS 인데 필수 케이스 ${id} 가 ${result.status} 입니다.`)
    }
  }
  if (verification.status === 'FAIL' && !verification.results.some((result) => result.status === 'FAIL')) {
    problems.push('FAIL 에는 실패한 케이스가 하나 이상 필요합니다.')
  }
  if (verification.status === 'BLOCKED' && !(Array.isArray(verification.issues) && verification.issues.length)) {
    problems.push('BLOCKED 에는 issues 가 필요합니다.')
  }
  return problems
}

// ─── 전이 조건 ──────────────────────────────────────────────────────────────

const GUARDS = {
  'refine>analyze'(state) {
    const { hash, criteria, commands } = readRequirements(state)
    state.requirements_hash = hash
    state.criteria = criteria
    state.commands = commands
    state.analysis = null
    state.cases_hash = null
    state.case_ids = []
    return `요구사항 해시 ${hash.slice(0, 12)}, 수용 기준 ${criteria.length}개, 검증 명령 ${commands.length}개`
  },
  'analyze>requirementsGate'(state, options) {
    requireUnchanged(state, '분석')
    const file = evidencePath(state, options.evidence, '회귀 분석 응답')
    const analysis = readJson(file)
    const problems = checkAnalysis(state, analysis)
    if (problems.length) reject(`회귀 분석 응답을 받아들일 수 없습니다.\n- ${problems.join('\n- ')}`)
    state.consumed.push(file)
    state.analysis = {
      file,
      status: analysis.status,
      required_candidates: analysis.regression_candidates.filter((candidate) => candidate.importance === 'REQUIRED').map((candidate) => candidate.id),
      decision_issues: analysis.issues.filter((issue) => issue.kind === 'REQUESTER_DECISION').map((issue) => issue.id),
    }
    return `분석 ${analysis.status}, 사용처 ${analysis.consumers.length}곳, 필수 회귀 후보 ${state.analysis.required_candidates.length}개`
  },
  'requirementsGate>cases'(state) {
    if (state.analysis?.status !== 'PASS') reject(`분석 판정이 ${state.analysis?.status ?? '없음'} 입니다. PASS 일 때만 cases 로 갑니다.`)
  },
  'requirementsGate>revise'(state) {
    if (state.analysis?.status !== 'REVISE') reject(`분석 판정이 ${state.analysis?.status ?? '없음'} 입니다. REVISE 일 때만 revise 로 갑니다.`)
  },
  'requirementsGate>clarify'(state) {
    if (state.analysis?.status !== 'BLOCKED') reject(`분석 판정이 ${state.analysis?.status ?? '없음'} 입니다. BLOCKED 일 때만 clarify 로 갑니다.`)
  },
  'clarify>refine'(state, options) {
    const pending = state.analysis?.decision_issues || []
    if (!pending.length) return '확보한 자료로 요구사항을 보완한다'
    const file = options.evidence ? resolve(options.evidence) : join(state.dir, 'decisions.md')
    if (file !== join(state.dir, 'decisions.md')) reject(`요청자 결정은 ${join(state.dir, 'decisions.md')} 에 기록해야 합니다.`)
    if (!existsSync(file)) reject(`요청자 결정 기록이 없습니다: ${file}. 이슈마다 질문, 선택지, 요청자의 답변을 적으세요.`)
    const text = readText(file)
    const missing = pending.filter((id) => {
      const section = text.split(/^##\s+/m).find((part) => part.startsWith(id))
      const answer = section?.match(/^[-*]?\s*답변\s*:\s*(.+)$/m)?.[1]?.trim()
      return !answer || /^(미정|TBD|todo|-|없음)$/i.test(answer)
    })
    if (missing.length) reject(`요청자 답변이 없는 결정이 있습니다: ${missing.join(', ')}. 요청자에게 묻고 decisions.md 의 "## <이슈 ID>" 절에 "- 답변: ..." 으로 적으세요. 요청자 대신 답하지 않습니다.`)
    state.decisions_hash = sha256(file)
    return `요청자 결정 ${pending.length}건 기록 확인`
  },
  'cases>implement'(state, options) {
    requireUnchanged(state, '케이스 확정')
    const file = evidencePath(state, options.evidence, '확정 케이스')
    if (file !== realpathSync(state.cases_file)) reject(`확정 케이스는 ${state.cases_file} 에 저장해야 합니다.`)
    const text = readText(file)
    const ids = caseIds(text)
    if (!ids.length) reject('확정 케이스 파일에 CASE-01 형식의 케이스가 없습니다.')
    const missing = [
      ...state.criteria.filter((id) => !new RegExp(`\\b${id}\\b`).test(text)),
      ...state.analysis.required_candidates.filter((id) => !new RegExp(`\\b${id}\\b`).test(text)),
    ]
    if (missing.length) reject(`확정 케이스에 연결되지 않은 기준이 있습니다: ${missing.join(', ')}. 모든 수용 기준과 필수 회귀 후보를 케이스에 연결하세요.`)
    state.cases_hash = sha256(file)
    state.case_ids = ids
    return `케이스 ${ids.length}개, 필수 회귀 후보 ${state.analysis.required_candidates.length}개 연결`
  },
  'implement>verify'(state, options) {
    requireUnchanged(state, '구현')
    const file = evidencePath(state, options.evidence, '구현 보고')
    const report = frontMatter(readText(file))
    const implementer = report.implementer_id
    if (!nonEmptyText(implementer)) reject('구현 보고 front matter 에 implementer_id(구현 서브에이전트의 ID 또는 이름)가 필요합니다.')
    if (report.task_id && report.task_id !== state.task_id) reject(`구현 보고의 task_id(${report.task_id})가 작업 ID(${state.task_id})와 다릅니다.`)
    let note = `구현 보고 ${relative(state.dir, file)}, 구현자 ${implementer}`
    if (state.implementer_id && state.implementer_id !== implementer) {
      if (!nonEmptyText(options['replace-implementer'])) {
        reject(`재작업은 기존 구현자(${state.implementer_id})에게 맡겨야 합니다. 이번 보고의 구현자는 ${implementer} 입니다.\n기존 구현자가 종료되어 이어서 맡길 수 없을 때만 --replace-implementer "<사유>" 로 교체를 기록하세요.`)
      }
      state.implementer_changes = [...(state.implementer_changes || []), { at: now(), from: state.implementer_id, to: implementer, reason: options['replace-implementer'] }]
      note += ` (구현자 교체: ${options['replace-implementer']})`
    }
    state.implementer_id = implementer
    state.consumed.push(file)
    return note
  },
  'verify>verificationGate'(state, options) {
    requireUnchanged(state, '검증')
    const file = evidencePath(state, options.evidence, '검증 응답')
    const verification = readJson(file)
    const problems = checkVerification(state, verification)
    if (problems.length) reject(`검증 응답을 받아들일 수 없습니다.\n- ${problems.join('\n- ')}`)
    state.consumed.push(file)
    state.verification = { file, status: verification.status }
    return `검증 ${verification.status}`
  },
  'verificationGate>done'(state) {
    if (state.verification?.status !== 'PASS') reject(`검증 판정이 ${state.verification?.status ?? '없음'} 입니다. PASS 일 때만 done 으로 갑니다.`)
  },
  'verificationGate>feedback'(state) {
    if (state.verification?.status !== 'FAIL') reject(`검증 판정이 ${state.verification?.status ?? '없음'} 입니다. FAIL 일 때만 feedback 으로 갑니다.`)
    state.feedback_rounds = (state.feedback_rounds || 0) + 1
  },
  'verificationGate>resolve'(state) {
    if (state.verification?.status !== 'BLOCKED') reject(`검증 판정이 ${state.verification?.status ?? '없음'} 입니다. BLOCKED 일 때만 resolve 로 갑니다.`)
  },
  'feedback>implement'(state) {
    state.verification = null
  },
  'resolve>verify'(state) {
    state.verification = null
  },
}

// ─── 명령 ───────────────────────────────────────────────────────────────────

function init(positional, options) {
  const [taskId] = positional
  if (!taskId || !ID_PATTERN.test(taskId)) reject('init <task_id>: 작업 ID 는 글자나 숫자로 시작하고 글자, 숫자, . _ : - 만 쓸 수 있습니다.')
  const dir = resolve(options.dir ?? join(process.cwd(), '.feedback', taskId))
  if (existsSync(statePath(dir))) reject(`이미 시작한 작업입니다: ${statePath(dir)}. status 로 현재 노드를 확인하세요.`)
  mkdirSync(dir, { recursive: true })
  const state = {
    task_id: taskId,
    dir,
    node: 'refine',
    requirements_file: join(dir, 'requirements.md'),
    cases_file: join(dir, 'cases.md'),
    requirements_hash: null,
    criteria: [],
    analysis: null,
    cases_hash: null,
    case_ids: [],
    commands: [],
    verification: null,
    feedback_rounds: 0,
    implementer_id: null,
    implementer_changes: [],
    consumed: [],
    created_at: now(),
  }
  saveState(state, { at: now(), from: null, to: 'refine', note: 'init' })
  return { dir, node: state.node, requirements_file: state.requirements_file, cases_file: state.cases_file }
}

function status(state) {
  const current = existsSync(state.requirements_file) && state.requirements_hash
    ? sha256(state.requirements_file) === state.requirements_hash
    : null
  return {
    task_id: state.task_id,
    dir: state.dir,
    node: state.node,
    next: EDGES[state.node],
    requirements_file: state.requirements_file,
    requirements_hash: state.requirements_hash,
    requirements_unchanged: current,
    cases_file: state.cases_file,
    commands: state.commands,
    analysis: state.analysis,
    verification: state.verification,
    feedback_rounds: state.feedback_rounds,
    implementer_id: state.implementer_id,
    implementer_changes: state.implementer_changes,
  }
}

function move(state, positional, options) {
  const [to] = positional
  if (!to) reject('move <다음 노드> 가 필요합니다.')
  const allowed = EDGES[state.node] || []
  if (!allowed.includes(to)) reject(`${state.node} 에서 ${to} 로 갈 수 없습니다. 갈 수 있는 노드: ${allowed.join(', ') || '없음'}`)
  if (to === 'incomplete' && !nonEmptyText(options.reason)) reject('incomplete 로 갈 때는 --reason 으로 미해결 사유를 적어야 합니다.')
  const guard = GUARDS[`${state.node}>${to}`]
  const note = guard ? guard(state, options) : undefined
  const from = state.node
  state.node = to
  saveState(state, { at: now(), from, to, evidence: options.evidence ? resolve(options.evidence) : null, reason: options.reason ?? null, note: note ?? null })
  return { from, to, note: note ?? null, next: EDGES[to] }
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, options } = parseArgs(rest)
  let result
  if (command === 'init') result = init(positional, options)
  else if (command === 'status') result = status(loadState(options.dir))
  else if (command === 'move') result = move(loadState(options.dir), positional, options)
  else reject('명령은 init, status, move 중 하나입니다.')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  if (!(error instanceof TransitionError)) throw error
  process.stderr.write(`전이 거부: ${error.message}\n`)
  process.exit(2)
}
