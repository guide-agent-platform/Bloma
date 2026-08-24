import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildAgentTools,
  EDIT_BUDGET_AFTER_TEST_FAILURE,
  setJsSyntaxCheckerForTests,
} from '../../main/agent-tools'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../main/agent-loop'
import { createProject, findProject, recordSketchGenerated } from '../../main/project-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/platform-services'
import { setBrowserGwtDisabledForTests } from '../../main/gwt-runner'

/**
 * PR2 L2 工具集单元测试（不接线，直接驱动工具 execute）。
 *
 * 覆盖（方案 §4.3 / §5 PR2 验收）：路径逃逸拒绝、截断契约、编辑校验拒绝（语法/
 * 结构护栏前置）、空反馈显式化、修复预算（edit-after-test-failure ≤3）。
 * 沙箱用既有 setSandboxRuntimeForTests 注入；GWT 固定走静态兜底（陷阱 32）。
 */

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  child.stdout = new EventEmitter() as never
  child.stderr = new EventEmitter() as never
  // kill 同步发 exit：terminateProcessTree 等 exit 事件，不发会每次等满 2s 兜底
  child.kill = () => {
    child.emit('exit', 0)
    return true
  }
  return child
}

function ctxFor(projectId: string): ToolContext {
  return {
    projectId,
    sessionId: 'session-tools',
    requestId: 'req-tools',
    signal: new AbortController().signal,
    state: createToolState(),
  }
}

function byName(tools: AgentLoopTool[], name: string): AgentLoopTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在：${name}`)
  return tool
}

/** 同步语法检查桩：以 "SYNTAX_ERROR" 标记的内容判失败。 */
const stubSyntaxChecker = async (content: string) =>
  content.includes('SYNTAX_ERROR') ? { ok: false as const, error: 'SyntaxError: Unexpected token (line 1)' } : { ok: true as const }

describe('agent-tools（PR2 L2）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-tools-'))
    setJsSyntaxCheckerForTests(stubSyntaxChecker)
    setBrowserGwtDisabledForTests(true)
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setJsSyntaxCheckerForTests(undefined)
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
  })

  describe('read_file / list_files / grep（safe 只读）', () => {
    it('read_file：默认窗口 100 行带行号，头尾提示总行数', async () => {
      const project = createProject({ request_id: 'req-r1', mode: 'quick' })
      writeFileSync(join(project.root_path, 'index.html'), Array.from({ length: 130 }, (_, i) => `第${i + 1}行`).join('\n'), 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'read_file').execute({ path: 'index.html' }, ctxFor(project.project_id))
      expect(outcome.output).toContain('共 130 行，显示第 1~100 行')
      expect(outcome.output).toContain('1 │ 第1行')
      expect(outcome.output).toContain('100 │ 第100行')
      expect(outcome.output).not.toContain('101 │')
    })

    it('read_file：offset 越界回退最近可用窗口', async () => {
      const project = createProject({ request_id: 'req-r2', mode: 'quick' })
      writeFileSync(join(project.root_path, 'a.js'), 'l1\nl2\nl3\nl4\nl5', 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'read_file').execute({ path: 'a.js', offset: 99, limit: 2 }, ctxFor(project.project_id))
      expect(outcome.output).toContain('显示第 4~5 行')
      expect(outcome.output).toContain('5 │ l5')
    })

    it('read_file：文件不存在 → is_error 并引导 list_files', async () => {
      const project = createProject({ request_id: 'req-r3', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'read_file').execute({ path: 'nope.js' }, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('文件不存在')
      expect(outcome.output).toContain('list_files')
    })

    it('list_files：相对路径列出并跳过 node_modules', async () => {
      const project = createProject({ request_id: 'req-l1', mode: 'quick' })
      writeFileSync(join(project.root_path, 'index.html'), '<html></html>', 'utf8')
      mkdirSync(join(project.root_path, 'src'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'app.js'), 'x', 'utf8')
      mkdirSync(join(project.root_path, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(project.root_path, 'node_modules', 'pkg', 'i.js'), 'x', 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'list_files').execute({}, ctxFor(project.project_id))
      expect(outcome.output).toContain('index.html')
      expect(outcome.output).toContain('src/app.js')
      expect(outcome.output).not.toContain('node_modules')
    })

    it('grep：只列命中 file:line（≤50），不给上下文行；无命中显式反馈', async () => {
      const project = createProject({ request_id: 'req-g1', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'app.js'), 'const a = 1\nconst target = 2\n', 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id })
      const hit = await byName(tools, 'grep').execute({ pattern: 'target', glob: '*.js' }, ctxFor(project.project_id))
      expect(hit.output).toContain('src/app.js:2')
      expect(hit.output).not.toContain('const target = 2')
      const miss = await byName(tools, 'grep').execute({ pattern: '不存在的关键词' }, ctxFor(project.project_id))
      expect(miss.output).toContain('未找到匹配')
      const bad = await byName(tools, 'grep').execute({ pattern: '(' }, ctxFor(project.project_id))
      expect(bad.isError).toBe(true)
      expect(bad.output).toContain('正则表达式无效')
    })
  })

  describe('write_file / edit_file（编辑护栏前置）', () => {
    it('路径沙箱：../ 逃逸、绝对路径、盘符路径一律拒绝', async () => {
      const project = createProject({ request_id: 'req-w1', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      for (const path of ['../escape.js', 'a/../../escape.js', 'C:/Windows/evil.js', '/etc/passwd']) {
        const outcome = await byName(tools, 'write_file').execute({ path, content: 'x' }, ctx)
        expect(outcome.isError, path).toBe(true)
        expect(outcome.output, path).toContain('项目目录内')
      }
      expect(existsSync(join(project.root_path, '..', 'escape.js'))).toBe(false)
    })

    it('可写范围：系统文件与白名单外后缀拒绝', async () => {
      const project = createProject({ request_id: 'req-w2', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      const system = await byName(tools, 'write_file').execute({ path: 'package.json', content: '{}' }, ctx)
      expect(system.isError).toBe(true)
      expect(system.output).toContain('平台管理')
      const ext = await byName(tools, 'write_file').execute({ path: 'data.txt', content: 'x' }, ctx)
      expect(ext.isError).toBe(true)
      expect(ext.output).toContain('可写范围')
    })

    it('JS 语法护栏：校验不过拒绝落盘并返回错误定位（stub）', async () => {
      const project = createProject({ request_id: 'req-w3', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'write_file').execute({ path: 'src/app.js', content: 'SYNTAX_ERROR const x =' }, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('JS 语法校验未通过')
      expect(outcome.output).toContain('SyntaxError')
      expect(existsSync(join(project.root_path, 'src', 'app.js'))).toBe(false)
    })

    it('真实 node --check：语法错误拒绝、合法内容放行', async () => {
      setJsSyntaxCheckerForTests(undefined)
      const project = createProject({ request_id: 'req-w3b', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      const bad = await byName(tools, 'write_file').execute({ path: 'src/bad.js', content: 'const x = {' }, ctx)
      expect(bad.isError).toBe(true)
      expect(bad.output).toContain('JS 语法校验未通过')
      const good = await byName(tools, 'write_file').execute({ path: 'src/app.js', content: "document.querySelector('button')\naddEventListener('click', () => {})" }, ctx)
      expect(good.isError).toBeUndefined()
      expect(existsSync(join(project.root_path, 'src', 'app.js'))).toBe(true)
    })

    it('HTML 结构护栏：script 不配平/缺 </html> 拒绝', async () => {
      const project = createProject({ request_id: 'req-w4', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      const unbalanced = await byName(tools, 'write_file').execute({ path: 'index.html', content: '<html><head></head><body><script>var a = 1;</body></html>' }, ctx)
      expect(unbalanced.isError).toBe(true)
      expect(unbalanced.output).toContain('script')
      expect(unbalanced.output).toContain('不匹配')
      const noEnd = await byName(tools, 'write_file').execute({ path: 'index.html', content: '<html><head></head><body></body>' }, ctx)
      expect(noEnd.isError).toBe(true)
      expect(noEnd.output).toContain('</html>')
    })

    it('成功写入返回字节数并剥离 meta CSP', async () => {
      const project = createProject({ request_id: 'req-w5', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const content = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body><script>var a=1;</script></body></html>'
      const outcome = await byName(tools, 'write_file').execute({ path: 'index.html', content }, ctxFor(project.project_id))
      expect(outcome.isError).toBeUndefined()
      expect(outcome.output).toContain('已写入 index.html')
      expect(outcome.output).toContain('剥离')
      const written = readFileSync(join(project.root_path, 'index.html'), 'utf8')
      expect(written).not.toContain('Content-Security-Policy')
    })

    it('edit_file diff 模式：唯一命中替换 / 未命中 / 多命中均如实反馈', async () => {
      const project = createProject({ request_id: 'req-e1', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'app.js'), 'const title = "旧标题";\nconsole.log(title);\n', 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)

      const miss = await byName(tools, 'edit_file').execute({ path: 'src/app.js', old_string: '不存在片段', new_string: 'x' }, ctx)
      expect(miss.isError).toBe(true)
      expect(miss.output).toContain('未命中')
      expect(miss.output).toContain('read_file')

      writeFileSync(join(project.root_path, 'src', 'app.js'), 'dup\ndup\n', 'utf8')
      const multi = await byName(tools, 'edit_file').execute({ path: 'src/app.js', old_string: 'dup', new_string: 'x' }, ctx)
      expect(multi.isError).toBe(true)
      expect(multi.output).toContain('不唯一')

      writeFileSync(join(project.root_path, 'src', 'app.js'), 'const title = "old";\n', 'utf8')
      const ok = await byName(tools, 'edit_file').execute({ path: 'src/app.js', old_string: '"old"', new_string: '"new"' }, ctx)
      expect(ok.isError).toBeUndefined()
      expect(readFileSync(join(project.root_path, 'src', 'app.js'), 'utf8')).toContain('"new"')
    })

    it('edit_file diff 模式：new_string 缺省 → 参数错误，不执行删除', async () => {
      const project = createProject({ request_id: 'req-e3', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'app.js'), 'const a = 1;\n', 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'edit_file').execute({ path: 'src/app.js', old_string: 'const a = 1' }, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('new_string')
      expect(readFileSync(join(project.root_path, 'src', 'app.js'), 'utf8')).toBe('const a = 1;\n')
    })

    it('edit_file schema：diff 模式 required 含 path/old_string/new_string', async () => {
      const project = createProject({ request_id: 'req-e4', mode: 'quick' })
      const tools = buildAgentTools({ projectId: project.project_id })
      const edit = byName(tools, 'edit_file')
      expect(edit.input_schema.required).toEqual(['path', 'old_string', 'new_string'])
    })

    it('edit_file whole 模式：content 整文件重写（弱渠道能力位）', async () => {
      const project = createProject({ request_id: 'req-e2', mode: 'quick' })
      writeFileSync(join(project.root_path, 'index.html'), '<html><head></head><body>旧</body></html>', 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id, editFormat: 'whole' })
      const outcome = await byName(tools, 'edit_file').execute({ path: 'index.html', content: '<html><head></head><body>新</body></html>' }, ctxFor(project.project_id))
      expect(outcome.isError).toBeUndefined()
      expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toContain('新')
      expect(tools.find((tool) => tool.name === 'edit_file')!.description).toContain('整文件重写')
    })
  })

  describe('run_preview / run_gwt_tests（沙箱注入）', () => {
    it('run_preview：探活成功返回 preview_url 并写入 state', async () => {
      const project = createProject({ request_id: 'req-p1', mode: 'quick' })
      writeFileSync(join(project.root_path, 'index.html'), '<html><head></head><body></body></html>', 'utf8')
      setSandboxRuntimeForTests({
        processFactory: () => fakeChild(),
        portAllocator: async () => 3971,
        healthCheck: async () => true,
      })
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      const outcome = await byName(tools, 'run_preview').execute({}, ctx)
      expect(outcome.isError).toBeUndefined()
      expect(outcome.output).toContain('http://localhost:3971')
      expect(ctx.state.preview_url).toBe('http://localhost:3971')
    })

    it('run_preview：启动失败返回分类摘要 + 日志尾部（is_error）', async () => {
      const project = createProject({ request_id: 'req-p2', mode: 'quick' })
      setSandboxRuntimeForTests({
        processFactory: () => {
          const child = fakeChild()
          // 崩溃退出 → classifySandboxFailure 走 runtime_error/dependency 分类
          setTimeout(() => child.emit('exit', 1), 5)
          return child
        },
        portAllocator: async () => 3972,
        healthCheck: async () => false,
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
      })
      const tools = buildAgentTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'run_preview').execute({}, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('预览启动失败')
      expect(outcome.output).toContain('日志尾部')
    })

    it('run_gwt_tests：无预览先引导 run_preview；有预览跑静态兜底并输出计数', async () => {
      const project = createProject({ request_id: 'req-t1', mode: 'quick' })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)

      const noPreview = await byName(tools, 'run_gwt_tests').execute({}, ctx)
      expect(noPreview.isError).toBe(true)
      expect(noPreview.output).toContain('run_preview')

      ctx.state.preview_url = 'http://127.0.0.1:1'
      const failed = await byName(tools, 'run_gwt_tests').execute({}, ctx)
      expect(failed.output).toContain('失败 1')
      expect(failed.output).toContain('预览不可访问')
      expect(ctx.state.test_failed).toBe(true)
      expect(ctx.state.repair_round).toBe(1)
    })

    it('run_gwt_tests：全部通过 → 显式「全部通过」并列出场景名', async () => {
      const project = createProject({ request_id: 'req-t2', mode: 'quick' })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      const server = createServer((_req, res) => {
        if (_req.url === '/src/app.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' })
          res.end("document.querySelector('button').addEventListener('click', function () {})")
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><button>开始使用</button><p>记录收入与支出</p></body></html>')
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      try {
        const tools = buildAgentTools({ projectId: project.project_id })
        const ctx = ctxFor(project.project_id)
        ctx.state.preview_url = `http://127.0.0.1:${port}`
        const outcome = await byName(tools, 'run_gwt_tests').execute({}, ctx)
        expect(outcome.output).toContain('全部通过（1/1')
        expect(outcome.output).toContain('F-001')
      } finally {
        server.close()
      }
    })

    it('修复预算：GWT 失败后第 4 次写入拿到软着陆提示（budgetExhausted）', async () => {
      const project = createProject({ request_id: 'req-t3', mode: 'quick' })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      const repairRounds: number[] = []
      const tools = buildAgentTools({ projectId: project.project_id, onRepairRound: (round) => repairRounds.push(round) })
      const ctx = ctxFor(project.project_id)
      ctx.state.preview_url = 'http://127.0.0.1:1' // 不可达 → 测试失败
      const gwt = await byName(tools, 'run_gwt_tests').execute({}, ctx)
      expect(gwt.output).toContain('失败')
      expect(repairRounds).toEqual([1])

      const writer = byName(tools, 'write_file')
      const outcomes = [] as Array<{ output: string; budgetExhausted?: boolean }>
      for (let i = 0; i < EDIT_BUDGET_AFTER_TEST_FAILURE + 1; i += 1) {
        outcomes.push(await writer.execute({ path: 'index.html', content: `<html><head></head><body>v${i}</body></html>` }, ctx))
      }
      // 前 3 次真实写入，第 4 次软着陆
      expect(outcomes.slice(0, EDIT_BUDGET_AFTER_TEST_FAILURE).every((outcome) => outcome.budgetExhausted === undefined)).toBe(true)
      expect(outcomes[EDIT_BUDGET_AFTER_TEST_FAILURE].budgetExhausted).toBe(true)
      expect(outcomes[EDIT_BUDGET_AFTER_TEST_FAILURE].output).toContain('预算已用尽')
      expect(ctx.state.edits_after_test_failure).toBe(EDIT_BUDGET_AFTER_TEST_FAILURE + 1)
    })

    it('修复预算：语法校验失败的写入不递增，合法写入递增 1', async () => {
      const project = createProject({ request_id: 'req-t4', mode: 'quick' })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      ctx.state.preview_url = 'http://127.0.0.1:1' // 不可达 → 测试失败
      const gwt = await byName(tools, 'run_gwt_tests').execute({}, ctx)
      expect(ctx.state.test_failed).toBe(true)

      const bad = await byName(tools, 'write_file').execute({ path: 'bad.js', content: 'SYNTAX_ERROR const x =' }, ctx)
      expect(bad.isError).toBe(true)
      expect(ctx.state.edits_after_test_failure).toBe(0) // 红：当前语法失败也烧预算 → 为 1

      const good = await byName(tools, 'write_file').execute({ path: 'index.html', content: '<html><head></head><body>ok</body></html>' }, ctx)
      expect(good.isError).toBeUndefined()
      expect(ctx.state.edits_after_test_failure).toBe(1)
    })
  })

  describe('run_security_scan', () => {
    it('高危命中 → 未通过并列出 file:line；干净项目 → 通过', async () => {
      const project = createProject({ request_id: 'req-s1', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'evil.js'), 'eval(userInput)\n', 'utf8')
      const tools = buildAgentTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)

      const bad = await byName(tools, 'run_security_scan').execute({}, ctx)
      expect(bad.output).toContain('未通过')
      expect(bad.output).toContain('src/evil.js:1')
      expect(bad.output).toContain('更安全的实现方式')

      writeFileSync(join(project.root_path, 'src', 'evil.js'), 'const safe = 1\n', 'utf8')
      const good = await byName(tools, 'run_security_scan').execute({}, ctx)
      expect(good.output).toContain('安全扫描通过')
    })
  })
})
