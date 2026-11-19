import { existsSync } from 'node:fs'
import { join } from 'node:path'

const kstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })

export function todayKst() {
  return kstDate.format(new Date())
}

export function parseBaseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`기준일은 YYYY-MM-DD 형식이어야 합니다: ${value}`)
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

// [며칠 전, 'HH:MM'(KST)] → UTC ISO 문자열
export function kstTimestamp(base, [daysAgo, time]) {
  const [hour, minute] = time.split(':').map(Number)
  return new Date(Date.UTC(base.year, base.month - 1, base.day - daysAgo, hour - 9, minute)).toISOString()
}

export function formatKst(iso) {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16)
}

export function requireDirectory(path, marker, description) {
  if (!existsSync(join(path, marker))) throw new Error(`${description}가 아닙니다: ${path}`)
}

export async function isListening(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

export function fail(error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
  process.exit(1)
}
