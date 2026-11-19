// 사용법: node reset.mjs <ai-agent-study 저장소 경로>
// basic, with-feedback 의 메타데이터 SQLite 와 file-store 데이터 전체를 지운다.
// 서버가 DB 를 연 채로 지우면 서버가 지워진 파일에 계속 쓰므로, 실행 중인 서버가 있으면 중단한다.
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fail, isListening, requireDirectory } from './lib.mjs'

const [rootArgument] = process.argv.slice(2)
if (!rootArgument) fail('사용법: node reset.mjs <ai-agent-study 저장소 경로>')

const root = resolve(rootArgument)
try {
  for (const project of ['basic', 'with-feedback', 'file-store']) {
    requireDirectory(join(root, project), 'package.json', `${project} 패키지`)
  }
} catch (error) {
  fail(error)
}

for (const [name, url] of [['앱 서버', 'http://localhost:8080/health'], ['file-store', 'http://localhost:6006/health']]) {
  if (await isListening(url)) fail(`${name}가 실행 중입니다 (${url}). 서버를 모두 종료한 뒤 다시 실행하세요.`)
}

const targets = [
  join(root, 'basic/.data/evidence'),
  join(root, 'with-feedback/.data/evidence'),
  join(root, 'file-store/.data'),
]
for (const target of targets) {
  if (!existsSync(target)) {
    process.stdout.write(`없음   ${target}\n`)
    continue
  }
  rmSync(target, { recursive: true })
  process.stdout.write(`삭제   ${target}\n`)
}
process.stdout.write('초기화를 마쳤습니다. 서버를 시작하면 빈 DB 가 만들어집니다.\n')
