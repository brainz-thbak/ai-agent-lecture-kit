import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

function reject(reason) {
  process.stderr.write(`${reason}\n`)
  process.exit(2)
}

const [filePath, ...extraArgs] = process.argv.slice(2)
if (!filePath || extraArgs.length) reject('Pass exactly one requirements file path.')

let requirementsFile
let content
try {
  const inputPath = resolve(filePath)
  if (!statSync(inputPath).isFile()) reject('The requirements path must be a file.')
  requirementsFile = realpathSync(inputPath)
  content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(requirementsFile))
} catch {
  reject('Unable to read the requirements file as UTF-8.')
}

const lines = content.split(/\r?\n/)
const headerEnd = lines.findIndex((line, index) => index > 0 && line === '---')
if (lines[0] !== '---' || headerEnd < 0) reject('Add task_id to the document front matter.')

const idEntries = lines.slice(1, headerEnd).filter((line) => /^task_id[ \t]*:/.test(line))
if (idEntries.length !== 1) reject('The document must contain exactly one task_id in its front matter.')

const value = idEntries[0].slice(idEntries[0].indexOf(':') + 1).trim()
const quotedValue = value.match(/^(['"])(.*)\1$/)
const taskId = quotedValue?.[2] ?? value
const idPattern = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u
if (!idPattern.test(taskId) || (!quotedValue && /^(null|true|false)$/i.test(taskId))) {
  reject('task_id must be a non-empty token.')
}

const requirements = lines.slice(headerEnd + 1).join('\n').trim()
if (!requirements) reject('The requirements file must contain a document body.')

process.stdout.write(`${JSON.stringify({ task_id: taskId, requirements_file: requirementsFile, requirements })}\n`)
