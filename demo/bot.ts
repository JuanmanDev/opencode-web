// The demo's "AI": a tiny keyword-driven agent that behaves like opencode on
// the wire. It streams text and reasoning as deltas, runs fake tools against
// the in-memory project files, asks permission before shell commands, asks
// questions, keeps a todo list, hands work to a subagent and shows MCP UI
// widgets. No model, no download: plausible, deterministic, honest about it.

import type { DemoMessage, Json } from './state'

export interface BotHost {
  id(prefix: string): string
  now(): number
  files(directory: string): Record<string, string>
  emit(directory: string, type: string, properties: Json): void
  messages(sessionID: string): DemoMessage[]
  session(sessionID: string): Json | undefined
  createChild(parent: Json, title: string, agent: string): Json
  touch(sessionID: string, title?: string): void
  setStatus(directory: string, sessionID: string, busy: boolean): void
  setTodos(directory: string, sessionID: string, todos: Json[]): void
  addDiff(sessionID: string, file: string, before: string, after: string): void
  askPermission(directory: string, request: Json): Promise<'once' | 'always' | 'reject'>
  askQuestion(directory: string, request: Json): Promise<string[][] | null>
  save(): void
}

export interface RunOptions {
  sessionID: string
  text: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
  variant?: string
  signal: AbortSignal
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
})

function chunks(text: string) {
  return text.match(/\S+\s*|\s+/g) || [text]
}

class Turn {
  readonly msg: DemoMessage
  constructor(
    private host: BotHost,
    readonly directory: string,
    readonly sessionID: string,
    readonly opts: RunOptions,
    parentID: string
  ) {
    const now = host.now()
    this.msg = {
      info: {
        id: host.id('msg'), sessionID, role: 'assistant', parentID, time: { created: now },
        modelID: opts.model?.modelID || 'demo-model', providerID: opts.model?.providerID || 'demo',
        agent: opts.agent || 'build', mode: opts.agent || 'build', variant: opts.variant,
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        path: { cwd: this.directory, root: this.directory }
      },
      parts: []
    }
    host.messages(sessionID).push(this.msg)
    this.emitInfo()
  }

  get thinks() {
    return this.opts.variant !== 'none' && this.opts.model?.modelID !== 'demo-fast'
  }

  emitInfo() {
    this.host.emit(this.directory, 'message.updated', { info: structuredClone(this.msg.info) })
  }

  emitPart(part: Json) {
    this.host.emit(this.directory, 'message.part.updated', { part: structuredClone(part) })
  }

  private check() {
    if (this.opts.signal.aborted) throw new DOMException('aborted', 'AbortError')
  }

  async stream(type: 'text' | 'reasoning', text: string, speed = 22) {
    this.check()
    const part: Json = { id: this.host.id('prt'), messageID: this.msg.info.id, sessionID: this.sessionID, type, text: '', time: { start: this.host.now() } }
    this.msg.parts.push(part)
    this.emitPart(part)
    for (const delta of chunks(text)) {
      await sleep(speed + Math.random() * speed, this.opts.signal)
      part.text += delta
      this.host.emit(this.directory, 'message.part.delta', { sessionID: this.sessionID, messageID: this.msg.info.id, partID: part.id, field: 'text', delta })
    }
    part.time.end = this.host.now()
    this.emitPart(part)
    this.msg.info.tokens.output += Math.ceil(text.length / 4)
    if (type === 'reasoning') this.msg.info.tokens.reasoning += Math.ceil(text.length / 4)
  }

  async tool(tool: string, input: Json, run: (part: Json) => Promise<{ output: string; title?: string; metadata?: Json }>) {
    this.check()
    const part: Json = { id: this.host.id('prt'), messageID: this.msg.info.id, sessionID: this.sessionID, type: 'tool', callID: this.host.id('call'), tool, state: { status: 'pending' } }
    this.msg.parts.push(part)
    this.emitPart(part)
    await sleep(160, this.opts.signal)
    const start = this.host.now()
    part.state = { status: 'running', input, title: titleOf(tool, input), metadata: {}, time: { start } }
    this.emitPart(part)
    try {
      await sleep(260 + Math.random() * 300, this.opts.signal)
      const result = await run(part)
      part.state = { status: 'completed', input, output: result.output, title: result.title ?? titleOf(tool, input), metadata: { ...(part.state.metadata || {}), ...(result.metadata || {}) }, time: { start, end: this.host.now() } }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        part.state = { status: 'error', input, error: 'Tool execution aborted', time: { start, end: this.host.now() } }
        this.emitPart(part)
        throw error
      }
      part.state = { status: 'error', input, error: (error as Error)?.message || String(error), time: { start, end: this.host.now() } }
    }
    this.emitPart(part)
    this.msg.info.tokens.input += 380
    return part
  }

  stepStart() {
    const part = { id: this.host.id('prt'), messageID: this.msg.info.id, sessionID: this.sessionID, type: 'step-start' }
    this.msg.parts.push(part)
    this.emitPart(part)
  }

  finish(error?: Json) {
    const cost = Number((this.msg.info.tokens.input * 0.000003 + this.msg.info.tokens.output * 0.000015).toFixed(5))
    this.msg.info.tokens.input += 2100
    this.msg.info.cost = cost
    const part = { id: this.host.id('prt'), messageID: this.msg.info.id, sessionID: this.sessionID, type: 'step-finish', cost, tokens: this.msg.info.tokens }
    this.msg.parts.push(part)
    this.emitPart(part)
    this.msg.info.time.completed = this.host.now()
    if (error) this.msg.info.error = error
    this.emitInfo()
  }
}

function titleOf(tool: string, input: Json) {
  if (tool === 'bash') return input.description || input.command
  if (tool === 'task') return input.description
  return input.filePath || input.pattern || input.label || input.location || input.pair || tool
}

// ---- fake tools against the in-memory project ----

function listFiles(files: Record<string, string>) {
  return Object.keys(files).sort()
}

function grep(files: Record<string, string>, pattern: string) {
  const re = new RegExp(pattern, 'i')
  const hits: string[] = []
  for (const [file, text] of Object.entries(files)) {
    text.split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`) })
  }
  return hits
}

function shell(command: string, files: Record<string, string>, fixed: boolean) {
  const c = command.trim()
  if (/^(npm|pnpm|yarn)( run)? test|vitest/.test(c)) {
    const tests = Object.keys(files).filter((f) => f.endsWith('.test.ts'))
    const count = tests.reduce((n, f) => n + (files[f]!.match(/\bit\(/g) || []).length, 0)
    if (!fixed && files['src/game/collision.ts']?.includes('FIXME')) {
      return ` RUN  v5.0.3\n\n ✓ tests/collision.test.ts (${count})\n\n Test Files  ${tests.length} passed (${tests.length})\n      Tests  ${count} passed (${count})\n   Duration  412ms`
    }
    return ` RUN  v5.0.3\n\n${tests.map((f) => ` ✓ ${f} (${(files[f]!.match(/\bit\(/g) || []).length})`).join('\n')}\n\n Test Files  ${tests.length} passed (${tests.length})\n      Tests  ${count} passed (${count})\n   Duration  438ms`
  }
  if (/^ls\b/.test(c)) return listFiles(files).filter((f) => !f.includes('/')).concat(['src/', 'tests/']).join('\n')
  if (/^git status/.test(c)) return 'On branch main\nChanges not staged for commit:\n  modified:   src/game/collision.ts\n\nno changes added to commit (use "git add" and/or "git commit -a")'
  if (/^git log/.test(c)) return 'a1c9e2f feat: shield power-up\n7b3d001 fix: invader spacing\n0f4a6c2 chore: vite 7'
  if (/^(npm|pnpm) (install|i)\b/.test(c)) return 'added 214 packages, and audited 215 packages in 3s\n\nfound 0 vulnerabilities'
  if (/build/.test(c)) return 'vite v7.0.4 building for production...\n✓ 18 modules transformed.\ndist/index.html                0.46 kB\ndist/assets/index-4f1c2b.js   12.31 kB │ gzip: 4.92 kB\n✓ built in 380ms'
  if (/^echo /.test(c)) return c.slice(5).replace(/^['"]|['"]$/g, '')
  return `$ ${c}\n(demo shell: commands are simulated in your browser)`
}

// ---- intents ----

type Intent = 'greet' | 'list' | 'read' | 'fix' | 'test' | 'run' | 'question' | 'todo' | 'subagent' | 'widget' | 'help'

function intentOf(text: string): Intent {
  const t = text.toLowerCase()
  if (/^\s*(hi|hello|hey|hola|buenas)\b/.test(t)) return 'greet'
  if (/subagent|sub-agent|delegate|review|audit|revisa/.test(t)) return 'subagent'
  if (/metric|chart|weather|widget|forex|dashboard|\bui\b|tiempo|gr[aá]fic/.test(t)) return 'widget'
  if (/\b(ask me|question|which|choose|pregunta|elige)\b/.test(t)) return 'question'
  if (/\b(test|tests|spec|prueba)\b/.test(t) && /\b(add|write|create|a[nñ]ade|crea|escribe)\b/.test(t)) return 'test'
  if (/\b(fix|bug|broken|error|arregla|falla)\b/.test(t)) return 'fix'
  if (/\b(run|bash|npm|build|install|ejecuta|lanza|git)\b|^!/.test(t)) return 'run'
  if (/\b(todo|plan|steps|pasos)\b/.test(t)) return 'todo'
  if (/\b(list|files|tree|structure|ls|archivos|ficheros)\b/.test(t)) return 'list'
  if (/\b(read|explain|what does|how does|show me|open|lee|explica)\b/.test(t)) return 'read'
  return 'help'
}

function pickFile(text: string, files: Record<string, string>) {
  const names = Object.keys(files)
  const lower = text.toLowerCase()
  return names.find((f) => lower.includes(f.toLowerCase()))
    || names.find((f) => lower.includes(f.split('/').pop()!.replace(/\.\w+$/, '').toLowerCase()))
    || (names.includes('src/game/loop.ts') ? 'src/game/loop.ts' : names.find((f) => f.startsWith('src/')) || names[0]!)
}

function describeFile(file: string, content: string) {
  const lines = content.split('\n').length
  const symbols = [...content.matchAll(/export (?:function|class|const|interface) (\w+)/g)].map((m) => m[1])
  const notes = [...content.matchAll(/(TODO|FIXME):? (.+)/g)].map((m) => `- ${m[1]}: ${m[2]}`)
  return `**\`${file}\`** (${lines} lines)${symbols.length ? ` exports ${symbols.map((s) => `\`${s}\``).join(', ')}` : ''}.\n\n`
    + (file.endsWith('collision.ts') ? 'It decides whether two boxes overlap with an axis-aligned test. Points (bullets) have no size, so they only hit when strictly inside a box.'
      : file.endsWith('loop.ts') ? 'It owns the game state, moves the player and bullets every frame, drops invaders hit by a bullet and draws the scene with `requestAnimationFrame`.'
        : file.endsWith('powerups.ts') ? 'The shield counts down 300 frames and reports `blinking` during the last 60.'
          : file.endsWith('.vue') ? 'A single-file Vue component: props in `<script setup>`, markup in `<template>`.'
            : 'A project file; nothing unusual in it.')
    + (notes.length ? `\n\nOpen notes in it:\n${notes.join('\n')}` : '')
}

const INTRO = '> 🧪 *Demo bot — I run in your browser with a few scripted skills, no real model. Try: "list the files", "fix the bug", "add a test", "run the tests", "ask me a question", "make a plan", "delegate a review to a subagent" or "show the weather widget".*\n\n'

export async function runTurn(host: BotHost, opts: RunOptions, userMessageID: string): Promise<DemoMessage> {
  const session = host.session(opts.sessionID)!
  const directory = session.directory
  const files = host.files(directory)
  const firstReply = !host.messages(opts.sessionID).some((m) => m.info.role === 'assistant')
  const turn = new Turn(host, directory, opts.sessionID, opts, userMessageID)
  host.setStatus(directory, opts.sessionID, true)
  const plan = opts.agent === 'plan'
  let error: Json | undefined
  try {
    turn.stepStart()
    const intro = firstReply ? INTRO : ''
    const intent = intentOf(opts.text)
    switch (intent) {
      case 'greet':
        await turn.stream('text', `${INTRO}Hi! I'm wired to this project (\`${directory}\`) through the same API as opencode, so everything you see — streaming, tool cards, permission prompts, questions, todos, subagents, MCP widgets — is the real web UI.`)
        break

      case 'list': {
        await turn.tool('glob', { pattern: '**/*' }, async () => ({ output: listFiles(files).join('\n'), title: '**/*' }))
        const tree = listFiles(files)
        await turn.stream('text', `${intro}The project has **${tree.length} files**:\n\n${tree.map((f) => `- \`${f}\``).join('\n')}\n\nAsk me to explain one of them, or to fix the bug that's hiding in there.`)
        break
      }

      case 'read': {
        const file = pickFile(opts.text, files)
        if (turn.thinks) await turn.stream('reasoning', `The user wants to understand ${file}. I'll read it and summarize what it does.`, 12)
        await turn.tool('read', { filePath: file }, async () => ({ output: files[file] || '', title: file }))
        await turn.stream('text', intro + describeFile(file, files[file] || ''))
        break
      }

      case 'fix': {
        if (turn.thinks) await turn.stream('reasoning', 'Look for TODO/FIXME markers first, then read the suspicious file and make the smallest change that fixes it.', 12)
        const hits = grep(files, 'FIXME|TODO')
        await turn.tool('grep', { pattern: 'FIXME|TODO' }, async () => ({ output: hits.join('\n') || 'No matches', title: 'FIXME|TODO' }))
        const target = files['src/game/collision.ts'] ? 'src/game/collision.ts' : hits[0]?.split(':')[0]
        if (!target || !files[target]) {
          await turn.stream('text', `${intro}I couldn't find an obvious bug marker here. Point me at a file and describe what goes wrong.`)
          break
        }
        await turn.tool('read', { filePath: target }, async () => ({ output: files[target]!, title: target }))
        const before = files[target]!
        const fixedAlready = !before.includes('FIXME')
        if (fixedAlready) {
          await turn.stream('text', `${intro}\`${target}\` is already fixed: touching edges count as a hit. Run the tests to confirm?`)
          break
        }
        if (plan) {
          await turn.stream('text', `${intro}**Plan (plan agent: no edits):**\n\n1. In \`${target}\`, change the strict \`<\`/\`>\` comparisons to \`<=\`/\`>=\` so touching edges collide\n2. Add a test for boxes that share an edge\n3. Run \`npm test\`\n\nSwitch to the **build** agent and I'll do it.`)
          break
        }
        const after = before
          .replace('  // FIXME: touching edges should count as a hit\n', '')
          .replace('return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y', 'return a.x <= b.x + bw && a.x + aw >= b.x && a.y <= b.y + bh && a.y + ah >= b.y')
        await turn.tool('edit', { filePath: target, oldString: 'a.x < b.x + bw && a.x + aw > b.x', newString: 'a.x <= b.x + bw && a.x + aw >= b.x' }, async () => {
          files[target] = after
          host.addDiff(opts.sessionID, target, before, after)
          return { output: 'Edit applied successfully.', title: target, metadata: { diff: '-  return a.x < b.x + bw …\n+  return a.x <= b.x + bw …' } }
        })
        await turn.stream('text', `${intro}Fixed the collision bug in \`${target}\`: the overlap test used strict comparisons, so a bullet exactly on an invader's edge flew through it.\n\n\`\`\`diff\n- return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y\n+ return a.x <= b.x + bw && a.x + aw >= b.x && a.y <= b.y + bh && a.y + ah >= b.y\n\`\`\`\n\nWant me to add a test for it? Open **Show file changes** in the header to see the diff.`)
        break
      }

      case 'test': {
        await turn.tool('todowrite', { todos: [] }, async (part) => {
          const todos = [
            { id: 't1', content: 'Cover boxes that share an edge', status: 'in_progress', priority: 'high' },
            { id: 't2', content: 'Cover a point inside a box', status: 'pending', priority: 'medium' },
            { id: 't3', content: 'Run the test suite', status: 'pending', priority: 'medium' }
          ]
          part.state.input = { todos }
          host.setTodos(directory, opts.sessionID, todos)
          return { output: JSON.stringify(todos, null, 2), title: '3 todos' }
        })
        const file = 'tests/collision.test.ts'
        const before = files[file] || "import { describe, expect, it } from 'vitest'\n\ndescribe('collides', () => {\n})\n"
        const after = before.replace(/\}\)\n?$/, `  it('counts touching edges as a hit', () => {\n    expect(collides({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(true)\n  })\n  it('hits a point inside a box', () => {\n    expect(collides({ x: 5, y: 5 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(true)\n  })\n})\n`)
        await turn.tool('edit', { filePath: file, oldString: '})', newString: '  it(…) ×2\n})' }, async () => {
          files[file] = after
          host.addDiff(opts.sessionID, file, before, after)
          return { output: 'Edit applied successfully.', title: file }
        })
        host.setTodos(directory, opts.sessionID, [
          { id: 't1', content: 'Cover boxes that share an edge', status: 'completed', priority: 'high' },
          { id: 't2', content: 'Cover a point inside a box', status: 'completed', priority: 'medium' },
          { id: 't3', content: 'Run the test suite', status: 'in_progress', priority: 'medium' }
        ])
        const ran = await runShell(host, turn, directory, opts.sessionID, 'npm test', 'Run the unit tests', files)
        host.setTodos(directory, opts.sessionID, [
          { id: 't1', content: 'Cover boxes that share an edge', status: 'completed', priority: 'high' },
          { id: 't2', content: 'Cover a point inside a box', status: 'completed', priority: 'medium' },
          { id: 't3', content: 'Run the test suite', status: ran ? 'completed' : 'cancelled', priority: 'medium' }
        ])
        await turn.stream('text', `${intro}Added two tests to \`${file}\`: touching edges and a point inside a box.${ran ? ' The suite passes.' : ' I did not run them since you declined the command.'}`)
        break
      }

      case 'run': {
        const command = /`([^`]+)`/.exec(opts.text)?.[1]
          || opts.text.replace(/^!/, '').match(/\b(npm [\w:-]+(?: [\w:-]+)?|git \w+|ls[^\n]*|echo [^\n]+)/i)?.[1]
          || 'npm test'
        const ran = await runShell(host, turn, directory, opts.sessionID, command, `Run ${command}`, files)
        await turn.stream('text', ran ? `${intro}Ran \`${command}\`; the output is in the tool card above.` : `${intro}Okay, I won't run \`${command}\`.`)
        break
      }

      case 'question': {
        const answer = await turn.tool('question', {
          questions: [{
            question: 'Which feature should I work on next?',
            header: 'Next step',
            options: [
              { label: 'Fix the collision bug', description: 'touching edges miss' },
              { label: 'Add tests', description: 'cover collisions' },
              { label: 'Clamp the player', description: 'stay inside the canvas' }
            ]
          }]
        }, async (part) => {
          const answers = await host.askQuestion(directory, {
            id: host.id('que'),
            sessionID: opts.sessionID,
            questions: part.state.input.questions,
            tool: { messageID: turn.msg.info.id, callID: part.callID }
          })
          if (!answers) throw new Error('The user dismissed this question')
          return { output: `User has answered your questions: "${part.state.input.questions[0].question}"="${answers[0]?.join(', ') || ''}"`, title: 'Asked 1 question' }
        })
        const picked = /="([^"]*)"/.exec(answer.state?.output || '')?.[1]
        await turn.stream('text', picked ? `${intro}Great — **${picked}** it is. Say "${picked.toLowerCase().startsWith('fix') ? 'fix the bug' : picked.toLowerCase().startsWith('add') ? 'add a test' : 'make a plan'}" and I'll start.` : `${intro}No problem, ask me anything else.`)
        break
      }

      case 'todo': {
        const todos = [
          { id: 'p1', content: 'Clamp the player inside the canvas (TODO in loop.ts)', status: 'pending', priority: 'high' },
          { id: 'p2', content: 'Fix edge collisions (FIXME in collision.ts)', status: 'pending', priority: 'high' },
          { id: 'p3', content: 'Document the pause key in the README', status: 'pending', priority: 'low' }
        ]
        await turn.tool('todowrite', { todos }, async () => {
          host.setTodos(directory, opts.sessionID, todos)
          return { output: JSON.stringify(todos, null, 2), title: `${todos.length} todos` }
        })
        await turn.stream('text', `${intro}Here's the plan — it's also in the task list above the prompt:\n\n${todos.map((t, i) => `${i + 1}. ${t.content}`).join('\n')}`)
        break
      }

      case 'subagent': {
        if (turn.thinks) await turn.stream('reasoning', 'A focused subagent can compare the README with the code while I keep my context small.', 12)
        const description = 'Check the README against the code'
        const prompt = 'Compare README.md with src/input.ts and list every control that is missing or wrong.'
        await turn.tool('task', { description, prompt, subagent_type: 'general' }, async (part) => {
          const child = host.createChild(session, `${description} (@general subagent)`, 'general')
          part.state.metadata = { parentSessionId: opts.sessionID, sessionId: child.id, model: { providerID: 'demo', modelID: 'demo-model' } }
          turn.emitPart(part)
          const result = await runChild(host, child, prompt, opts.signal)
          return { output: `<task id="${child.id}" state="completed">\n<task_result>\n${result}\n</task_result>\n</task>`, title: description }
        })
        await turn.stream('text', `${intro}The subagent found that the fire key is \`Space\` in the code while the README says \`Enter\`, and that pause (\`P\`) is undocumented. Shall I update the README?`)
        break
      }

      case 'widget': {
        const t = opts.text.toLowerCase()
        if (/weather|tiempo/.test(t) || !/metric|chart|forex/.test(t)) {
          await turn.tool('ui-demo_show_weather', { location: 'Salamanca', temperature: 24, condition: 'sunny', humidity: 38, wind: 9 }, async () => ({ output: 'Salamanca: 24°C, sunny', title: 'Salamanca' }))
        }
        if (/metric|dashboard|revenue/.test(t)) {
          await turn.tool('ui-demo_show_metric', { label: 'Revenue', value: '42', unit: 'k€', change: 12.5 }, async () => ({ output: 'Revenue: 42k€ (12.5%)', title: 'Revenue' }))
        }
        if (/chart|forex|gr[aá]fic/.test(t)) {
          await turn.tool('ui-demo_show_forex', { pair: 'EUR/USD' }, async () => ({ output: 'EUR/USD over 48h', title: 'EUR/USD' }))
        }
        await turn.stream('text', `${intro}These cards come from the \`ui-demo\` MCP server and render live in the chat (MCP UI). Use the toolbar on a card to open it fullscreen or in the side panel.`)
        break
      }

      default: {
        if (turn.thinks) await turn.stream('reasoning', 'Nothing specific matched. Read the README for context and offer what I can do.', 12)
        await turn.tool('read', { filePath: 'README.md' }, async () => ({ output: files['README.md'] || '', title: 'README.md' }))
        await turn.stream('text', `${intro}I'm only a demo bot, so I can't really reason about "${opts.text.slice(0, 80)}${opts.text.length > 80 ? '…' : ''}". What I *can* show you:\n\n- **list the files** / **explain src/game/loop.ts**\n- **fix the bug** (edits a file, see *Show file changes*)\n- **add a test** (todo list + edit + shell with a permission prompt)\n- **run the tests** / \`!git status\`\n- **ask me a question** (interactive question card)\n- **delegate a review to a subagent** (child session)\n- **show the weather widget** / **show a chart** (MCP UI apps)`)
      }
    }
  } catch (e) {
    error = (e as Error)?.name === 'AbortError'
      ? { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } }
      : { name: 'UnknownError', data: { message: (e as Error)?.message || String(e) } }
  }
  turn.finish(error)
  host.touch(opts.sessionID)
  host.setStatus(directory, opts.sessionID, false)
  host.save()
  return turn.msg
}

async function runShell(host: BotHost, turn: Turn, directory: string, sessionID: string, command: string, description: string, files: Record<string, string>) {
  let allowed = true
  await turn.tool('bash', { command, description }, async (part) => {
    const reply = await host.askPermission(directory, {
      id: host.id('per'),
      type: 'bash',
      permission: 'bash',
      pattern: [command],
      sessionID,
      messageID: turn.msg.info.id,
      callID: part.callID,
      title: command,
      metadata: { command, description },
      time: { created: host.now() }
    })
    if (reply === 'reject') {
      allowed = false
      throw new Error('The user rejected permission to use this specific tool call.')
    }
    return { output: shell(command, files, !files['src/game/collision.ts']?.includes('FIXME')), title: description, metadata: { exit: 0, description } }
  })
  return allowed
}

async function runChild(host: BotHost, child: Json, prompt: string, signal: AbortSignal) {
  const userID = host.id('msg')
  const user: DemoMessage = {
    info: { id: userID, sessionID: child.id, role: 'user', time: { created: host.now() } },
    parts: [{ id: host.id('prt'), messageID: userID, sessionID: child.id, type: 'text', text: prompt }]
  }
  host.messages(child.id).push(user)
  host.emit(child.directory, 'message.updated', { info: user.info })
  host.emit(child.directory, 'message.part.updated', { part: user.parts[0] })
  const files = host.files(child.directory)
  const turn = new Turn(host, child.directory, child.id, { sessionID: child.id, text: prompt, agent: 'general', signal }, userID)
  host.setStatus(child.directory, child.id, true)
  turn.stepStart()
  await turn.tool('read', { filePath: 'README.md' }, async () => ({ output: files['README.md'] || '', title: 'README.md' }))
  await turn.tool('read', { filePath: 'src/input.ts' }, async () => ({ output: files['src/input.ts'] || '(no input handling found)', title: 'src/input.ts' }))
  const result = files['src/input.ts']
    ? "- Fire is `Space` in src/input.ts, the README says `Enter`\n- Pause (`P`) is not documented"
    : '- No input handling in this project: nothing to compare'
  await turn.stream('text', result, 16)
  turn.finish()
  host.touch(child.id)
  host.setStatus(child.directory, child.id, false)
  return result
}
