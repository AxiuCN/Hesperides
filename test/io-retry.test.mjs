// HTTP 重试策略：文本与二进制用同一套规则
//
// 早先 `fetchText()` 拿到响应就返回，5xx 一次都不重试；`fetchBuffer()` 除了 403/404 都会重试。
// 结果同一个上游抽风，图片能自愈、文本只能等下一轮。本套件锁住两边的对称性。
import { mod, checker } from './_helper.mjs'

const { fetchText, fetchBuffer } = await import(mod('src/core/io.mjs'))
const { check, finish } = checker()

/** 假响应（同时满足 text / arrayBuffer 两种消费方式） */
function fakeRes (status, body = 'ok') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body)
  }
}

/**
 * 装一个按脚本响应（或抛错）的假 fetch
 * @param {(string|number)[]} script - 数字为状态码，'throw' 为网络异常；用完后重复最后一项
 * @returns {() => number} 读取调用次数
 */
function stubFetch (script) {
  let calls = 0
  globalThis.fetch = async () => {
    const step = script[Math.min(calls, script.length - 1)]
    calls += 1
    if (step === 'throw') throw new Error('ECONNRESET')
    return fakeRes(step)
  }
  return () => calls
}

// 退避基数压到 1ms：只验证「会不会再试」，不验证退避时长
const fast = { retries: 2, retryDelayMs: 1 }

console.log('=== ① fetchText 的 5xx 会重试 ===')
{
  const calls = stubFetch([503, 200])
  const res = await fetchText('https://example.invalid/x', fast)
  check('503 后重试成功', res.ok === true && res.status === 200 && res.text === 'ok')
  check('确实发了两次请求', calls() === 2, `calls=${calls()}`)
}
{
  const calls = stubFetch([500])
  const res = await fetchText('https://example.invalid/x', fast)
  check('一直 5xx → 失败', res.ok === false)
  check('重试到次数上限（首次 + retries）', calls() === 3, `calls=${calls()}`)
  check('失败时保留最后一次错误', String(res.error).includes('500'), res.error)
}
{
  const calls = stubFetch(['throw', 200])
  const res = await fetchText('https://example.invalid/x', fast)
  check('网络异常仍重试', res.ok === true && calls() === 2)
}

console.log('\n=== ② 403 / 404 不重试（没有就是没有）===')
for (const status of [404, 403]) {
  const calls = stubFetch([status, 200])
  const res = await fetchText('https://example.invalid/x', fast)
  check(`文本 ${status} 一次即返`, res.ok === false && res.status === status && calls() === 1,
    `calls=${calls()}`)
}
{
  const calls = stubFetch([404, 200])
  const res = await fetchBuffer('https://example.invalid/x', fast)
  check('二进制 404 一次即返（原有行为）', res.ok === false && calls() === 1, `calls=${calls()}`)
}

console.log('\n=== ③ 两边规则一致 ===')
{
  const textCalls = stubFetch([502, 200])
  const textRes = await fetchText('https://example.invalid/x', fast)
  const bufferCalls = stubFetch([502, 200])
  const bufferRes = await fetchBuffer('https://example.invalid/x', fast)
  check('502 两边都重试', textCalls() === 2 && bufferCalls() === 2,
    `text=${textCalls()} buffer=${bufferCalls()}`)
  check('502 后两边都成功', textRes.ok === true && bufferRes.ok === true)

  const textFail = stubFetch([503])
  const textFailed = await fetchText('https://example.invalid/x', fast)
  const bufferFail = stubFetch([503])
  const bufferFailed = await fetchBuffer('https://example.invalid/x', fast)
  check('一直 503 两边都失败', textFailed.ok === false && bufferFailed.ok === false)
  check('一直 503 两边重试次数相同', textFail() === bufferFail(), `text=${textFail()} buffer=${bufferFail()}`)
}

finish()