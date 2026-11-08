/**
 * 回归套件公共设施：路径推导 / 断言计数 / 跳过
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const testDir = path.dirname(fileURLToPath(import.meta.url))
export const rootDir = path.resolve(testDir, '..')
export const tmpDir = path.join(testDir, '.test-tmp')

/** 相对仓库根 import 模块 */
export const mod = (relPath) => pathToFileURL(path.join(rootDir, relPath)).href

/** 建临时目录（已 gitignore） */
export function ensureTmp () {
  fs.mkdirSync(tmpDir, { recursive: true })
  return tmpDir
}

/** 清空并重建临时子目录 */
export function freshDir (name) {
  const dir = path.join(tmpDir, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 断言计数器
 * @returns {{check: Function, counts: Function, finish: Function}}
 */
export function checker () {
  let pass = 0
  let fail = 0
  return {
    check (name, ok, extra = '') {
      ok ? pass++ : fail++
      console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`)
    },
    counts: () => ({ pass, fail }),
    finish () {
      console.log(`\n结果：通过 ${pass} / 失败 ${fail}`)
      process.exit(fail === 0 ? 0 : 1)
    }
  }
}

/** 缺前置时打印跳过并 exit 0（与 Atlas-Plugin 的套件约定一致） */
export function skip (reason) {
  console.log(`⏭ 跳过：${reason}`)
  process.exit(0)
}
