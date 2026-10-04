// Deterministic OpenAI-compatible model (streaming /v1/chat/completions) for
// the compat e2e suite: real opencode servers of any version talk to it.
// The reply is keyed on the last user message: "bash" -> bash tool call,
// "ask" -> question tool, "todo" -> todowrite, "read" -> read tool,
// "slow" -> a long streamed answer, anything else -> "Hello from the mock model."
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.MOCK_LLM_PORT || 4811)
const LOG = process.env.MOCK_LLM_LOG
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function chunk(res, delta, finish = null, usage) {
  const body = {
    id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {})
  }
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

const usage = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 }

http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  let body = {}
  try { body = JSON.parse(raw || '{}') } catch { /* not JSON */ }
  const msgs = body.messages || []
  const last = msgs[msgs.length - 1] || {}
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : (lastUser?.content || []).map((p) => p.text || '').join(' ')
  if (LOG) {
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), url: req.url, lastRole: last.role, userText: userText.slice(0, 200), tools: (body.tools || []).map((t) => t.function?.name) }) + '\n')
  }
  if (!req.url.includes('chat/completions')) {
    res.writeHead(404)
    return res.end('{}')
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

  // title generation and other side requests: answer with a short plain text
  const system = msgs.find((m) => m.role === 'system')
  const systemText = typeof system?.content === 'string' ? system.content : ''
  if (/title/i.test(systemText) && !(body.tools || []).length) {
    chunk(res, { role: 'assistant', content: 'Mock conversation' })
    chunk(res, {}, 'stop')
    chunk(res, {}, null, usage)
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  if (last.role === 'tool') {
    for (const piece of ['Tool ', 'finished ', 'OK.']) {
      chunk(res, { content: piece })
      await sleep(80)
    }
    chunk(res, {}, 'stop')
    chunk(res, {}, null, usage)
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  const toolCall = (name, args) => {
    chunk(res, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name, arguments: '' } }] })
    const s = JSON.stringify(args)
    chunk(res, { tool_calls: [{ index: 0, function: { arguments: s.slice(0, 10) } }] })
    chunk(res, { tool_calls: [{ index: 0, function: { arguments: s.slice(10) } }] })
    chunk(res, {}, 'tool_calls')
    chunk(res, {}, null, usage)
    res.write('data: [DONE]\n\n')
    res.end()
  }
  if (/\bbash\b/i.test(userText)) return toolCall('bash', { command: 'echo hello-from-bash', description: 'Echo test' })
  if (/\bask\b/i.test(userText)) return toolCall('question', { questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] })
  if (/\btodo\b/i.test(userText)) return toolCall('todowrite', { todos: [{ content: 'Write spec', status: 'in_progress', priority: 'high' }] })
  if (/\bread\b/i.test(userText)) return toolCall('read', { filePath: 'README.md' })
  const slow = /\bslow\b/i.test(userText)
  chunk(res, { role: 'assistant', reasoning_content: 'Thinking ' })
  await sleep(60)
  chunk(res, { reasoning_content: 'about it.' })
  await sleep(60)
  const pieces = slow ? Array.from({ length: 40 }, (_, i) => `w${i} `) : ['Hello ', 'from ', 'the ', 'mock ', 'model.']
  for (const piece of pieces) {
    chunk(res, { content: piece })
    await sleep(slow ? 250 : 60)
  }
  chunk(res, {}, 'stop')
  chunk(res, {}, null, usage)
  res.write('data: [DONE]\n\n')
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(`mock llm on ${PORT}`))
