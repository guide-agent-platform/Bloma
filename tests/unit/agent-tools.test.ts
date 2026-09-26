import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAgentTools,
  createWriteScope,
  EDIT_BUDGET_AFTER_TEST_FAILURE,
  setJsSyntaxCheckerForTests,
} from '../../main/agent/tools/agent-tools'
import { buildDomainTools, domainToolOptionsDefaults } from '../../main/coding/tool-handlers'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../main/agent/loop/agent-loop'
import { createProject, findProject, recordSketchGenerated } from '../../main/project/project-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/delivery/sandbox'
import { writeRealScaffoldMarker } from '../../main/coding/preview-runtime'
import { setBrowserGwtDisabledForTests } from '../../main/verification/gwt-runner'
import { getDocumentsDir } from '../../storage/config-paths'

/** PR4c：生产装配=通用件+领域件拼接（含变体/地图刷新缺省补全）；测试沿用同一口径 */
const composeTools = (o: Parameters<typeof buildAgentTools>[0]) => {
  const full = { ...o, ...domainToolOptionsDefaults(o.projectId) }
  return [...buildAgentTools(full), ...buildDomainTools(full)]
}


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
    restorePromaHome(originalPromaHome)
    setJsSyntaxCheckerForTests(undefined)
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
  })

  describe('read_file / list_files / grep（safe 只读）', () => {
    it('read_file：默认窗口 100 行带行号，头尾提示总行数', async () => {
      const project = createProject({ request_id: 'req-r1', mode: 'quick' })
      writeFileSync(join(project.root_path, 'index.html'), Array.from({ length: 130 }, (_, i) => `第${i + 1}行`).join('\n'), 'utf8')
      const tools = composeTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'read_file').execute({ path: 'index.html' }, ctxFor(project.project_id))
      expect(outcome.output).toContain('共 130 行，显示第 1~100 行')
      expect(outcome.output).toContain('1 │ 第1行')
      expect(outcome.output).toContain('100 │ 第100行')
      expect(outcome.output).not.toContain('101 │')
    })

    it('read_file：offset 越界回退最近可用窗口', async () => {
      const project = createProject({ request_id: 'req-r2', mode: 'quick' })
      writeFileSync(join(project.root_path, 'a.js'), 'l1\nl2\nl3\nl4\nl5', 'utf8')
      const tools = composeTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'read_file').execute({ path: 'a.js', offset: 99, limit: 2 }, ctxFor(project.project_id))
      expect(outcome.output).toContain('显示第 4~5 行')
      expect(outcome.output).toContain('5 │ l5')
    })

    it('read_file：文件不存在 → is_error 并引导 list_files', async () => {
      const project = createProject({ request_id: 'req-r3', mode: 'quick' })
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'list_files').execute({}, ctxFor(project.project_id))
      expect(outcome.output).toContain('index.html')
      expect(outcome.output).toContain('src/app.js')
      expect(outcome.output).not.toContain('node_modules')
    })

    it('grep：只列命中 file:line（≤50），不给上下文行；无命中显式反馈', async () => {
      const project = createProject({ request_id: 'req-g1', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'app.js'), 'const a = 1\nconst target = 2\n', 'utf8')
      const tools = composeTools({ projectId: project.project_id })
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
    it('[S4-AGENT-054] write_file 超大内容预拦截：≥16k tokens 拒绝并引导分块（费用守卫 Hook 3，2026-08-28）', async () => {
      const project = createProject({ request_id: 'req-w-big', mode: 'quick' })
      const tools = composeTools({ projectId: project.project_id })
      const huge = 'x'.repeat(70_000) // 70000 ASCII ≈ 17500 tokens ≥ 16k 阈值
      const outcome = await byName(tools, 'write_file').execute({ path: 'big.html', content: huge }, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('17500')
      expect(outcome.output).toContain('edit_file')
      // 拒绝即未落盘
      expect(existsSync(join(project.root_path, 'big.html'))).toBe(false)
    })

    it('[S4-AGENT-055] 正常大小写入不受影响（零回归）', async () => {
      const project = createProject({ request_id: 'req-w-ok', mode: 'quick' })
      const tools = composeTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'write_file').execute({ path: 'ok.html', content: '<html><body>ok</body></html>' }, ctxFor(project.project_id))
      expect(outcome.isError).toBeFalsy()
      expect(existsSync(join(project.root_path, 'ok.html'))).toBe(true)
    })

    it('路径沙箱：../ 逃逸、绝对路径、盘符路径一律拒绝', async () => {
      const project = createProject({ request_id: 'req-w1', mode: 'quick' })
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      const system = await byName(tools, 'write_file').execute({ path: 'package.json', content: '{}' }, ctx)
      expect(system.isError).toBe(true)
      expect(system.output).toContain('平台管理')
      // M-7：大小写变体同样拒绝（Windows 大小写不敏感文件系统上 'Static-Server.js'
      // 会实际覆盖 static-server.js——篡改沙箱服务端含 CSP 响应头）
      const cased = await byName(tools, 'write_file').execute({ path: 'Static-Server.js', content: '// hijack' }, ctx)
      expect(cased.isError).toBe(true)
      expect(cased.output).toContain('平台管理')
      const casedJson = await byName(tools, 'write_file').execute({ path: 'Package.JSON', content: '{}' }, ctx)
      expect(casedJson.isError).toBe(true)
      // T-2：8.3 短名别名同样拒绝（实测写入 'STATIC~1.JS' 命中 static-server.js、
      // 'PACKAG~1.JSO' 命中 package.json——短名扩展名截 3 字符）
      for (const short of ['STATIC~1.JS', 'static~2.js', 'PACKAG~1.JSO', 'Packag~3.jso']) {
        const shortOutcome = await byName(tools, 'write_file').execute({ path: short, content: '// hijack' }, ctx)
        expect(shortOutcome.isError, short).toBe(true)
        expect(shortOutcome.output, short).toContain('平台管理')
      }
      // 非系统文件的普通短名形态不受影响（创建新文件无害）
      const benign = await byName(tools, 'write_file').execute({ path: 'MYFILE~1.JS', content: 'const x = 1' }, ctx)
      expect(benign.isError).toBeFalsy()
      const ext = await byName(tools, 'write_file').execute({ path: 'data.txt', content: 'x' }, ctx)
      expect(ext.isError).toBe(true)
      expect(ext.output).toContain('可写范围')
    })

    it('[W3] 真实脚手架变体写边界：package.json/server.js/任意后缀皆产物可写；node_modules/.git/data-backups/标记拒绝', async () => {
      const project = createProject({ request_id: 'req-w3-real', mode: 'quick' })
      writeRealScaffoldMarker(project.root_path, 'real-fullstack')
      const tools = composeTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      // package.json 是真实工程件（可改）；server/ 下路由模块可建；任意后缀（README.md）可写
      const pkg = await byName(tools, 'write_file').execute({ path: 'package.json', content: '{"name":"app"}' }, ctx)
      expect(pkg.isError).toBeFalsy()
      const route = await byName(tools, 'write_file').execute({ path: 'server/routes/notes.js', content: 'module.exports = {}' }, ctx)
      expect(route.isError).toBeFalsy()
      const md = await byName(tools, 'write_file').execute({ path: 'README.md', content: '# app' }, ctx)
      expect(md.isError).toBeFalsy()
      // 基础设施目录与变体标记拒绝
      for (const path of ['node_modules/evil.js', '.git/config', 'data-backups/x.json']) {
        const outcome = await byName(tools, 'write_file').execute({ path, content: 'x' }, ctx)
        expect(outcome.isError, path).toBe(true)
      }
      const marker = await byName(tools, 'write_file').execute({ path: '.bloma-real-variant', content: 'real-static' }, ctx)
      expect(marker.isError).toBe(true)
      expect(marker.output).toContain('平台管理')
    })

    it('[PR-1] 骨架参考示例目录只读：src/examples/ 写入拒绝（含大小写变体），read_file 可读', async () => {
      const project = createProject({ request_id: 'req-w2b', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src', 'examples'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'examples', 'data-module.js'), 'function createDataModule() {}', 'utf8')
      const tools = composeTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      for (const path of ['src/examples/data-module.js', 'src/examples/other.js', 'SRC/EXAMPLES/data-module.js', 'src/Examples/x.js']) {
        const outcome = await byName(tools, 'write_file').execute({ path, content: '// tamper' }, ctx)
        expect(outcome.isError, path).toBe(true)
        expect(outcome.output, path).toContain('只读参考示例')
      }
      // 只读不影响读取：参考模式仍可 read_file（注入⑥引导 read_file 参考后自实现）
      const read = await byName(tools, 'read_file').execute({ path: 'src/examples/data-module.js' }, ctx)
      expect(read.isError).toBeFalsy()
      expect(read.output).toContain('createDataModule')
      // 业务目录不受影响：src/ 下其他路径照常可写
      const ok = await byName(tools, 'write_file').execute({ path: 'src/app.js', content: 'var a = 1' }, ctx)
      expect(ok.isError).toBeFalsy()
    })

    it('[PR-1] edit_file 同样受只读目录约束（validateAndWrite 统一护栏）', async () => {
      const project = createProject({ request_id: 'req-w2c', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src', 'examples'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'examples', 'data-module.js'), 'function createDataModule() {}', 'utf8')
      const tools = composeTools({ projectId: project.project_id, editFormat: 'whole' })
      const outcome = await byName(tools, 'edit_file').execute({ path: 'src/examples/data-module.js', content: 'function hijack() {}' }, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('只读参考示例')
    })

    it('[P1-模块] 官方模块目录只读：src/official-modules/ 写入拒绝（含大小写变体），read_file 可读', async () => {
      const project = createProject({ request_id: 'req-w2d', mode: 'quick' })
      mkdirSync(join(project.root_path, 'src', 'official-modules', 'game-loop'), { recursive: true })
      writeFileSync(join(project.root_path, 'src', 'official-modules', 'game-loop', 'game-loop.js'), 'export function createGameLoop() {}', 'utf8')
      const tools = composeTools({ projectId: project.project_id })
      const ctx = ctxFor(project.project_id)
      for (const path of ['src/official-modules/game-loop/game-loop.js', 'SRC/OFFICIAL-MODULES/game-loop/game-loop.js']) {
        const outcome = await byName(tools, 'write_file').execute({ path, content: '// tamper' }, ctx)
        expect(outcome.isError, path).toBe(true)
        expect(outcome.output, path).toContain('官方模块')
      }
      // 只读不影响读取：参考实现仍可 read_file
      const read = await byName(tools, 'read_file').execute({ path: 'src/official-modules/game-loop/game-loop.js' }, ctx)
      expect(read.isError).toBeFalsy()
      expect(read.output).toContain('createGameLoop')
    })

    it('JS 语法护栏：校验不过拒绝落盘并返回错误定位（stub）', async () => {
      const project = createProject({ request_id: 'req-w3', mode: 'quick' })
      const tools = composeTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'write_file').execute({ path: 'src/app.js', content: 'SYNTAX_ERROR const x =' }, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('JS 语法校验未通过')
      expect(outcome.output).toContain('SyntaxError')
      expect(existsSync(join(project.root_path, 'src', 'app.js'))).toBe(false)
    })

    it('真实 node --check：语法错误拒绝、合法内容放行', async () => {
      setJsSyntaxCheckerForTests(undefined)
      const project = createProject({ request_id: 'req-w3b', mode: 'quick' })
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'edit_file').execute({ path: 'src/app.js', old_string: 'const a = 1' }, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('new_string')
      expect(readFileSync(join(project.root_path, 'src', 'app.js'), 'utf8')).toBe('const a = 1;\n')
    })

    it('edit_file schema：diff 模式 required 含 path/old_string/new_string', async () => {
      const project = createProject({ request_id: 'req-e4', mode: 'quick' })
      const tools = composeTools({ projectId: project.project_id })
      const edit = byName(tools, 'edit_file')
      expect(edit.input_schema.required).toEqual(['path', 'old_string', 'new_string'])
    })

    it('edit_file whole 模式：content 整文件重写（弱渠道能力位）', async () => {
      const project = createProject({ request_id: 'req-e2', mode: 'quick' })
      writeFileSync(join(project.root_path, 'index.html'), '<html><head></head><body>旧</body></html>', 'utf8')
      const tools = composeTools({ projectId: project.project_id, editFormat: 'whole' })
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
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
      const outcome = await byName(tools, 'run_preview').execute({}, ctxFor(project.project_id))
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('预览启动失败')
      expect(outcome.output).toContain('日志尾部')
    })

    it('run_gwt_tests：无预览先引导 run_preview；有预览跑静态兜底并输出计数', async () => {
      const project = createProject({ request_id: 'req-t1', mode: 'quick' })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      const tools = composeTools({ projectId: project.project_id })
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
        const tools = composeTools({ projectId: project.project_id })
        const ctx = ctxFor(project.project_id)
        ctx.state.preview_url = `http://127.0.0.1:${port}`
        const outcome = await byName(tools, 'run_gwt_tests').execute({}, ctx)
        expect(outcome.output).toContain('全部通过（1/1')
        expect(outcome.output).toContain('F-001')
      } finally {
        server.close()
      }
    })

    it('M-11：全过分支清零失败粘性——test_failed/edits_after_test_failure 复位（否则后续安全修复被旧预算堵死）', async () => {
      const project = createProject({ request_id: 'req-t2-sticky', mode: 'quick' })
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
        const tools = composeTools({ projectId: project.project_id })
        const ctx = ctxFor(project.project_id)
        ctx.state.preview_url = `http://127.0.0.1:${port}`
        // 模拟此前一轮失败已烧 3 次修复预算
        ctx.state.test_failed = true
        ctx.state.edits_after_test_failure = 3
        const outcome = await byName(tools, 'run_gwt_tests').execute({}, ctx)
        expect(outcome.output).toContain('全部通过（1/1')
        // 失败粘性清零：后续安全修复的 edit 不再计入旧测试失败预算
        expect(ctx.state.test_failed).toBe(false)
        expect(ctx.state.edits_after_test_failure).toBe(0)
        expect(ctx.state.gwt_all_passed).toBe(true)
      } finally {
        server.close()
      }
    })

    it('修复预算：GWT 失败后第 4 次写入拿到软着陆提示（budgetExhausted）', async () => {
      const project = createProject({ request_id: 'req-t3', mode: 'quick' })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      const repairRounds: number[] = []
      const tools = composeTools({ projectId: project.project_id, onRepairRound: (round) => repairRounds.push(round) })
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
      const tools = composeTools({ projectId: project.project_id })
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
      const tools = composeTools({ projectId: project.project_id })
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

  describe('web_fetch（联网只读 + SSRF 防护）', () => {
    /** 构造鸭型 Response（不发真实网络）。 */
    function fakeResponse(init: {
      ok?: boolean
      status?: number
      url?: string
      contentType?: string
      body?: string
    }): Response {
      const encoder = new TextEncoder()
      const bytes = encoder.encode(init.body ?? '')
      return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        url: init.url ?? 'https://example.com/docs',
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (init.contentType ?? 'text/html; charset=utf-8') : null) },
        arrayBuffer: async () => bytes.buffer,
      } as unknown as Response
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('内网/本机/非常规地址一律拒绝且不发起网络请求', async () => {
      const project = createProject({ request_id: 'req-wf-1', mode: 'quick' })
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      const tool = byName(composeTools({ projectId: project.project_id }), 'web_fetch')
      const ctx = ctxFor(project.project_id)

      for (const url of [
        'http://localhost:3000/x',
        'http://127.0.0.1/x',
        'http://192.168.1.1/admin',
        'http://10.0.0.5/x',
        'http://172.16.0.1/x',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/x',
        'http://[fd00::1]/x',
        'file:///C:/Windows/win.ini',
        'ftp://example.com/x',
        'http://intranet/doc',
        'http://2130706433/x',
      ]) {
        const result = await tool.execute({ url }, ctx)
        expect(result.isError, `URL 应被拒绝：${url}`).toBe(true)
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('W3 补丁（21:07 狗粮实锤）：预览 origin 同源响应放行——修复轮自查 API/页面不再被终态复检误杀', async () => {
      const project = createProject({ request_id: 'req-wf-w3b', mode: 'quick' })
      const fetchSpy = vi.fn(async () =>
        fakeResponse({
          ok: false,
          status: 404,
          url: 'http://localhost:3001/api/records',
          contentType: 'application/json',
          body: '{"error":"not_found"}',
        }),
      )
      vi.stubGlobal('fetch', fetchSpy)
      const tool = byName(composeTools({ projectId: project.project_id }), 'web_fetch')
      const ctx = ctxFor(project.project_id)
      ctx.state.preview_url = 'http://localhost:3001'

      const result = await tool.execute({ url: 'http://localhost:3001/api/records' }, ctx)
      // 终态同源：不再是「重定向到了不允许的地址」，而是如实拿到 404 口径（可判读）
      expect(result.isError).toBe(true)
      expect(result.output).toContain('HTTP 404')
      expect(result.output).not.toContain('重定向到了不允许的地址')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('公网 HTML → 剧本/样式剔除、标签剥离、实体解码、保留可见文本', async () => {
      const project = createProject({ request_id: 'req-wf-2', mode: 'quick' })
      const fetchSpy = vi.fn(async () =>
        fakeResponse({
          url: 'https://example.com/docs',
          body:
            '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>' +
            '<body><h1>API 文档</h1><p>GET /add 返回 &lt;sum&gt;&amp;&amp; 总和</p><!-- 注释 --><li>限流说明</li></body></html>',
        }),
      )
      vi.stubGlobal('fetch', fetchSpy)
      const ctx = ctxFor(project.project_id)

      const result = await byName(composeTools({ projectId: project.project_id }), 'web_fetch').execute(
        { url: 'https://example.com/docs' },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      const text = String(result.output)
      expect(text).toContain('API 文档')
      expect(text).toContain('<sum>&& 总和')
      expect(text).toContain('限流说明')
      expect(text).not.toContain('alert(1)')
      expect(text).not.toContain('color:red')
      expect(text).toContain('example.com')
    })

    it('超长文本按 max_chars 截断并提示；非 2xx / 二进制 / 重定向入内网如实报错', async () => {
      const project = createProject({ request_id: 'req-wf-3', mode: 'quick' })
      const ctx = ctxFor(project.project_id)
      const long = 'x'.repeat(30_000)

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => fakeResponse({ body: long, contentType: 'text/plain' })),
      )
      const truncated = await byName(composeTools({ projectId: project.project_id }), 'web_fetch').execute(
        { url: 'https://example.com/big' },
        ctx,
      )
      expect(String(truncated.output)).toContain('已截断')
      expect(String(truncated.output).length).toBeLessThan(20_000)

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => fakeResponse({ ok: false, status: 404 })),
      )
      const missing = await byName(composeTools({ projectId: project.project_id }), 'web_fetch').execute(
        { url: 'https://example.com/none' },
        ctx,
      )
      expect(missing.isError).toBe(true)
      expect(String(missing.output)).toContain('HTTP 404')

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => fakeResponse({ contentType: 'image/png' })),
      )
      const binary = await byName(composeTools({ projectId: project.project_id }), 'web_fetch').execute(
        { url: 'https://example.com/logo.png' },
        ctx,
      )
      expect(binary.isError).toBe(true)
      expect(String(binary.output)).toContain('不支持的响应类型')

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => fakeResponse({ url: 'http://192.168.0.1/redirected' })),
      )
      const redirected = await byName(composeTools({ projectId: project.project_id }), 'web_fetch').execute(
        { url: 'https://example.com/go' },
        ctx,
      )
      expect(redirected.isError).toBe(true)
      expect(String(redirected.output)).toContain('重定向到了不允许的地址')
    })

    it('角色裁剪：explore/research 含 web_fetch；权限登记为 warning', async () => {
      const project = createProject({ request_id: 'req-wf-4', mode: 'quick' })
      const explore = composeTools({ projectId: project.project_id, role: 'explore' })
      expect(explore.map((tool) => tool.name)).toContain('web_fetch')
      const parent = composeTools({ projectId: project.project_id })
      expect(parent.map((tool) => tool.name)).toContain('web_fetch')

      const { TOOL_PERMISSION_REGISTRY } = await import('../../main/agent/permissions/permission-service')
      expect(TOOL_PERMISSION_REGISTRY.web_fetch).toBe('warning')
    })
  })
})

describe('web_research 工具面（闭环 PR5）', () => {
  it('仅 parent 可见：research/implement/explore 子代理无 web_research（防递归委派）', () => {
    delete process.env.BLOMA_BROWSER_TOOLS
    delete process.env.BLOMA_COMPACT_TOOL
    delete process.env.BLOMA_API_TOOL
    const parentNames = composeTools({ projectId: 'p' }).map((tool) => tool.name)
    expect(parentNames).toContain('web_research')
    // W3（Phase 10）：find 只读工具无条件注册，基线 17→18；浏览器/压缩开关必须显式钉 off
    // （并发测试文件共享 process.env，见 scrape 管道同款先例）
    expect(parentNames).toHaveLength(18)

    for (const role of ['research', 'explore', 'implement', 'review', 'custom'] as const) {
      const names = composeTools({ projectId: 'p', role }).map((tool) => tool.name)
      expect(names).not.toContain('web_research')
    }
  })
})

describe('agent-tools D 系列（咨询 D：验证协议，2026-09-09）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalApiTool = process.env.BLOMA_API_TOOL
  const originalEvidence = process.env.BLOMA_TOOL_EVIDENCE
  const originalWriteGuard = process.env.BLOMA_WRITE_GUARD

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-tools-d-'))
    setJsSyntaxCheckerForTests(stubSyntaxChecker)
    setBrowserGwtDisabledForTests(true)
    delete process.env.BLOMA_API_TOOL
    delete process.env.BLOMA_TOOL_EVIDENCE
    delete process.env.BLOMA_WRITE_GUARD
    delete process.env.BLOMA_BROWSER_TOOLS
    delete process.env.BLOMA_COMPACT_TOOL
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setJsSyntaxCheckerForTests(undefined)
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
    if (originalApiTool === undefined) delete process.env.BLOMA_API_TOOL
    else process.env.BLOMA_API_TOOL = originalApiTool
    if (originalEvidence === undefined) delete process.env.BLOMA_TOOL_EVIDENCE
    else process.env.BLOMA_TOOL_EVIDENCE = originalEvidence
    if (originalWriteGuard === undefined) delete process.env.BLOMA_WRITE_GUARD
    else process.env.BLOMA_WRITE_GUARD = originalWriteGuard
  })

  it('D1：开关 off 工具面=现状（无 run_api_contract_tests，parent 含 find 共 18 个）；on 注册且变 19', () => {
    const project = createProject({ request_id: 'req-d-reg', mode: 'quick' })
    const off = composeTools({ projectId: project.project_id }).map((t) => t.name)
    expect(off).not.toContain('run_api_contract_tests')
    expect(off).toHaveLength(18)
    process.env.BLOMA_API_TOOL = '1'
    const on = composeTools({ projectId: project.project_id }).map((t) => t.name)
    expect(on).toContain('run_api_contract_tests')
    expect(on).toHaveLength(19)
    // review 角色同样可用（只读验证面）
    const review = composeTools({ projectId: project.project_id, role: 'review' }).map((t) => t.name)
    expect(review).toContain('run_api_contract_tests')
  })

  it('D1：API 工具无预览先引导 run_preview（与 run_gwt_tests 同口径）', async () => {
    process.env.BLOMA_API_TOOL = '1'
    const project = createProject({ request_id: 'req-d-nopv', mode: 'quick' })
    const tools = composeTools({ projectId: project.project_id })
    const outcome = await byName(tools, 'run_api_contract_tests').execute({}, ctxFor(project.project_id))
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('run_preview')
  })

  it('D1：无 interface_spec → 豁免通过并置位 api_all_passed（纯静态产物不强制跑）', async () => {
    process.env.BLOMA_API_TOOL = '1'
    const project = createProject({ request_id: 'req-d-exempt', mode: 'quick' })
    const tools = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)
    ctx.state.api_all_passed = false // 模拟「有契约预置」，验证豁免也能翻正
    ctx.state.preview_url = 'http://127.0.0.1:1'
    const outcome = await byName(tools, 'run_api_contract_tests').execute({}, ctx)
    expect(outcome.output).toContain('豁免')
    expect(ctx.state.api_all_passed).toBe(true)
  })

  it('D1：有契约全过 → 通过并置位；有失败 → 明细含「API 契约端点」且不置位（location 口径对齐终验/修复轮）', async () => {
    process.env.BLOMA_API_TOOL = '1'
    const project = createProject({ request_id: 'req-d-contract', mode: 'quick' })
    // 写最小合法背板（requirements 数组即可被 readPrdBackplane 接受）
    const docsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    writeFileSync(
      join(docsDir, 'prd.json'),
      JSON.stringify({ requirements: [], interface_spec: [{ endpoint: '/api/notes', method: 'GET' }] }),
      'utf8',
    )
    const tools = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)

    // 全过：本地 server 应答 /api/notes
    const okServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"notes":[]}')
    })
    await new Promise<void>((resolve) => okServer.listen(0, '127.0.0.1', resolve))
    const okPort = (okServer.address() as AddressInfo).port
    ctx.state.preview_url = `http://127.0.0.1:${okPort}`
    const passed = await byName(tools, 'run_api_contract_tests').execute({}, ctx)
    expect(passed.output).toContain('全部应答正常')
    expect(ctx.state.api_all_passed).toBe(true)
    okServer.close()

    // 失败：404 server
    const badServer = createServer((_req, res) => {
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((resolve) => badServer.listen(0, '127.0.0.1', resolve))
    const badPort = (badServer.address() as AddressInfo).port
    ctx.state.preview_url = `http://127.0.0.1:${badPort}`
    const failed = await byName(tools, 'run_api_contract_tests').execute({}, ctx)
    expect(failed.output).toContain('API 契约端点')
    expect(failed.output).toContain('/api/notes')
    expect(ctx.state.api_all_passed).toBe(false)
    badServer.close()
  })

  it('D2：off=字节级现状（全过仍含旧收口提示）；on=验证状态行替代收口暗示，全验证面通过才说「可输出完成总结」', async () => {
    const project = createProject({ request_id: 'req-d-evidence', mode: 'quick' })
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
      // off：现状原文
      const toolsOff = composeTools({ projectId: project.project_id })
      const ctxOff = ctxFor(project.project_id)
      ctxOff.state.preview_url = `http://127.0.0.1:${port}`
      const off = await byName(toolsOff, 'run_gwt_tests').execute({}, ctxOff)
      expect(off.output).toContain('测试通过，可以继续 run_security_scan 或输出完成总结。')
      expect(off.output).not.toContain('验证状态')

      // on：尚缺 security/api → 不再出现收口暗示
      process.env.BLOMA_TOOL_EVIDENCE = '1'
      const toolsOn = composeTools({ projectId: project.project_id })
      const ctxOn = ctxFor(project.project_id)
      ctxOn.state.preview_url = `http://127.0.0.1:${port}`
      const on = await byName(toolsOn, 'run_gwt_tests').execute({}, ctxOn)
      expect(on.output).toContain('验证状态')
      expect(on.output).toContain('尚缺')
      expect(on.output).not.toContain('或输出完成总结') // 仅在全部通过时出现
      // 全验证面通过 → 明确放行
      ctxOn.state.security_all_passed = true
      ctxOn.state.api_all_passed = true
      const all = await byName(toolsOn, 'run_gwt_tests').execute({}, ctxOn)
      expect(all.output).toContain('全部验证面通过，可输出完成总结')
    } finally {
      server.close()
    }
  })

  it('D3：失败条目首轮标 [新增]、同场景复跑标 [持续]（防重复修同一失败）', async () => {
    process.env.BLOMA_TOOL_EVIDENCE = '1'
    const project = createProject({ request_id: 'req-d-d3', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const tools = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)
    ctx.state.preview_url = 'http://127.0.0.1:1' // 不可访问 → 稳定失败
    const first = await byName(tools, 'run_gwt_tests').execute({}, ctx)
    expect(first.output).toContain('[新增] ')
    const second = await byName(tools, 'run_gwt_tests').execute({}, ctx)
    expect(second.output).toContain('[持续] ')
  })

  it('D4a：read_file 返回文件版本；STALE_READ 拦截旧版本编辑；不传 rev 零变化', async () => {
    const project = createProject({ request_id: 'req-d-rev', mode: 'quick' })
    const tools = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)
    const abs = join(project.root_path, 'src', 'app.js')
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'const a = 1\n', 'utf8')

    const read = await byName(tools, 'read_file').execute({ path: 'src/app.js' }, ctx)
    expect(read.output).toContain('文件版本 ')
    const rev = (read.output.match(/文件版本 ([0-9a-f-]+)/) ?? [])[1]
    expect(rev).toBeTruthy()

    // 读后被外部修改 → 传旧 rev 被 STALE_READ 拒绝
    writeFileSync(abs, 'const a = 2\n', 'utf8')
    const stale = await byName(tools, 'edit_file').execute(
      { path: 'src/app.js', old_string: 'const a = 2', new_string: 'const a = 3', expected_revision: rev },
      ctx,
    )
    expect(stale.isError).toBe(true)
    expect(stale.output).toContain('STALE_READ')

    // P1-06（2026-09-26 审计）：不传 rev 也拦——提交点校验基准取本会话读到的版本
    //（原「不传零变化」正是审计点名的漏洞：读后被外部修改仍能凭旧内容改写）
    const alsoStale = await byName(tools, 'edit_file').execute(
      { path: 'src/app.js', old_string: 'const a = 2', new_string: 'const a = 3' },
      ctx,
    )
    expect(alsoStale.isError).toBe(true)
    expect(alsoStale.output).toContain('STALE_READ')
    // 重新 read_file 刷新版本基准 → 编辑成功
    await byName(tools, 'read_file').execute({ path: 'src/app.js' }, ctx)
    const ok = await byName(tools, 'edit_file').execute(
      { path: 'src/app.js', old_string: 'const a = 2', new_string: 'const a = 3' },
      ctx,
    )
    expect(ok.isError).toBeFalsy()
    expect(readFileSync(abs, 'utf8')).toContain('const a = 3')
  })

  it('D4a：write 守卫 off=现状零变化；on=盲覆盖既有文件被拒，read 后放行，新文件不受影响', async () => {
    const project = createProject({ request_id: 'req-d-guard', mode: 'quick' })
    const abs = join(project.root_path, 'index.html')
    writeFileSync(abs, '<html><body><p>旧内容</p></body></html>', 'utf8')

    // off：直接覆盖（现状）
    const toolsOff = composeTools({ projectId: project.project_id })
    const off = await byName(toolsOff, 'write_file').execute(
      { path: 'index.html', content: '<html><body><p>新内容</p></body></html>' },
      ctxFor(project.project_id),
    )
    expect(off.isError).toBeFalsy()

    // on：重建文件后盲覆盖被拒
    process.env.BLOMA_WRITE_GUARD = '1'
    writeFileSync(abs, '<html><body><p>旧内容</p></body></html>', 'utf8')
    const toolsOn = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)
    const blocked = await byName(toolsOn, 'write_file').execute(
      { path: 'index.html', content: '<html><body><p>再覆盖</p></body></html>' },
      ctx,
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toContain('本轮未读取过')

    // read 后放行
    await byName(toolsOn, 'read_file').execute({ path: 'index.html' }, ctx)
    const allowed = await byName(toolsOn, 'write_file').execute(
      { path: 'index.html', content: '<html><body><p>读后覆盖</p></body></html>' },
      ctx,
    )
    expect(allowed.isError).toBeFalsy()

    // 新文件不受守卫影响
    const fresh = await byName(toolsOn, 'write_file').execute(
      { path: 'src/new.js', content: 'const b = 1\n' },
      ctx,
    )
    expect(fresh.isError).toBeFalsy()
  })
})

describe('W2-F4：run_gwt_tests 修复比较与计数器', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalEvidence = process.env.BLOMA_TOOL_EVIDENCE

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-tools-w2-'))
    setBrowserGwtDisabledForTests(true)
    delete process.env.BLOMA_TOOL_EVIDENCE
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
    if (originalEvidence === undefined) delete process.env.BLOMA_TOOL_EVIDENCE
    else process.env.BLOMA_TOOL_EVIDENCE = originalEvidence
  })

  it('较上次行：resolved 列出已修场景、新增提示回归；state 快照无条件更新（终验 source 判据）', async () => {
    process.env.BLOMA_TOOL_EVIDENCE = '1'
    const project = createProject({ request_id: 'req-w2-f4', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const tools = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)
    ctx.state.preview_url = 'http://127.0.0.1:1' // 不可访问 → 稳定失败集
    // 预置上轮失败集：本轮真实失败与之既不重合（全算新增）→ resolved=预置项
    ctx.state.last_gwt_failures = ['F-099 上轮已修场景']
    const run = await byName(tools, 'run_gwt_tests').execute({}, ctx)
    expect(run.output).toContain('较上次：修复 1（F-099 上轮已修场景）')
    expect(run.output).toContain('新增 1')
    // 计数器与快照：gwt_runs=1；last_gwt_failures 已换成本轮真实失败集
    expect(ctx.state.gwt_runs).toBe(1)
    const realFailures = ctx.state.last_gwt_failures ?? []
    expect(realFailures.length).toBeGreaterThan(0)
    expect(realFailures).not.toContain('F-099 上轮已修场景')
    // 复跑：上轮真实失败本轮仍在 → [持续]，且 resolved=0
    const again = await byName(tools, 'run_gwt_tests').execute({}, ctx)
    expect(again.output).toContain('[持续] ')
    expect(again.output).toContain('持续 1')
    expect(ctx.state.gwt_runs).toBe(2)
  })

  it('开关 off：比较行与标注不出现，但 gwt_runs/last_gwt_failures 照常维护', async () => {
    delete process.env.BLOMA_TOOL_EVIDENCE
    const project = createProject({ request_id: 'req-w2-f4-off', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const tools = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)
    ctx.state.preview_url = 'http://127.0.0.1:1'
    const run = await byName(tools, 'run_gwt_tests').execute({}, ctx)
    expect(run.output).not.toContain('较上次')
    expect(ctx.state.gwt_runs).toBe(1)
    expect((ctx.state.last_gwt_failures ?? []).length).toBeGreaterThan(0)
  })
})

describe('W3-D1/D2：run_preflight 收口预检', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalPreflight = process.env.BLOMA_PREFLIGHT

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-tools-w3-'))
    setBrowserGwtDisabledForTests(true)
    delete process.env.BLOMA_PREFLIGHT
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
    if (originalPreflight === undefined) delete process.env.BLOMA_PREFLIGHT
    else process.env.BLOMA_PREFLIGHT = originalPreflight
  })

  it('开关 off 不注册（字节级现状）；on 注册 run_preflight', () => {
    const project = createProject({ request_id: 'req-w3-reg', mode: 'quick' })
    const off = composeTools({ projectId: project.project_id }).map((t) => t.name)
    expect(off).not.toContain('run_preflight')
    process.env.BLOMA_PREFLIGHT = '1'
    const on = composeTools({ projectId: project.project_id }).map((t) => t.name)
    expect(on).toContain('run_preflight')
  })

  it('预检执行：按阶段报告（GWT 失败/契约豁免/UI 探针留痕/安全），preflight_passed=false 留 loop 内修', async () => {
    process.env.BLOMA_PREFLIGHT = '1'
    const project = createProject({ request_id: 'req-w3-run', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const tools = composeTools({ projectId: project.project_id })
    const ctx = ctxFor(project.project_id)
    ctx.state.preview_url = 'http://127.0.0.1:1' // 不可达 → GWT 稳定失败、UI 探针 unavailable
    const result = await byName(tools, 'run_preflight').execute({}, ctx)
    expect(result.output).toContain('【收口预检】')
    expect(result.output).toContain('① GWT 行为断言：失败')
    expect(result.output).toContain('② API 契约：豁免')
    expect(result.output).toContain('③ 产物 UI 审计：未执行')
    expect(result.output).toContain('④ 安全扫描')
    expect(result.output).toContain('收口预检未通过')
    expect(result.output).toContain('留在当前循环内修复')
    expect(ctx.state.preflight_passed).toBe(false)
    expect(ctx.state.gwt_all_passed).toBe(false)
    // 失败快照与计数口径与 run_gwt_tests 一致（终验 source 分类判据）
    expect(ctx.state.gwt_runs).toBe(1)
    expect((ctx.state.last_gwt_failures ?? []).length).toBeGreaterThan(0)
  })

  it('无预览时明确前置（先 run_preview），不误判', async () => {
    process.env.BLOMA_PREFLIGHT = '1'
    const project = createProject({ request_id: 'req-w3-nopv', mode: 'quick' })
    const tools = composeTools({ projectId: project.project_id })
    const result = await byName(tools, 'run_preflight').execute({}, ctxFor(project.project_id))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('run_preview')
  })
})

describe('W4-F2/F3：修复轮修改授权边界 + repair_control 窄入口', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalSyntax = process.env.BLOMA_WRITE_GUARD

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-tools-w4-'))
    setJsSyntaxCheckerForTests(stubSyntaxChecker)
    setBrowserGwtDisabledForTests(true)
    delete process.env.BLOMA_WRITE_GUARD
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setJsSyntaxCheckerForTests(undefined)
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
    if (originalSyntax === undefined) delete process.env.BLOMA_WRITE_GUARD
    else process.env.BLOMA_WRITE_GUARD = originalSyntax
  })

  it('越界写被 WRITE_SCOPE_DENIED 拦（blocked+next_actions，不诱导绕权限）；授权内照常', async () => {
    const project = createProject({ request_id: 'req-w4-scope', mode: 'quick' })
    const scope = createWriteScope(['src/app.js'])
    const tools = composeTools({ projectId: project.project_id, writeScope: scope })
    const ctx = ctxFor(project.project_id)
    // 越界 edit：被拒并给出恢复路径
    const denied = await byName(tools, 'edit_file').execute(
      { path: 'index.html', old_string: 'a', new_string: 'b' },
      ctx,
    )
    expect(denied.isError).toBe(true)
    expect(denied.output).toContain('WRITE_SCOPE_DENIED')
    expect(denied.output).toContain('repair_control')
    expect((denied.detail as { next_actions?: unknown[] }).next_actions).toBeTruthy()
    // 授权内 write：照常（新建文件）
    const allowed = await byName(tools, 'write_file').execute(
      { path: 'src/app.js', content: 'const a = 1\n' },
      ctx,
    )
    expect(allowed.isError).toBeFalsy()
    // 无 holder（主 loop 现状）：不拦
    const plainTools = composeTools({ projectId: project.project_id })
    const plain = await byName(plainTools, 'write_file').execute(
      { path: 'index.html', content: '<html></html>' },
      ctxFor(project.project_id),
    )
    expect(plain.isError).toBeFalsy()
  })

  it('repair_control：扩大申请自动批准→写放行；通配符/受保护路径拒绝；缺字段用法错误；report_blocker 记录', async () => {
    const project = createProject({ request_id: 'req-w4-ctl', mode: 'quick' })
    const scope = createWriteScope(['src/app.js'], ['prd.json'])
    const tools = composeTools({ projectId: project.project_id, writeScope: scope })
    const ctx = ctxFor(project.project_id)
    // 注册面：writeScope 在 → repair_control 在
    expect(tools.map((t) => t.name)).toContain('repair_control')
    // 扩大申请：普通实现文件 → 批准 + 后续写放行
    const approved = await byName(tools, 'repair_control').execute({
      action: 'request_scope_expansion',
      issue_id: 'F-005',
      requested_paths: ['src/store.js'],
      reason: '过滤逻辑实现在 store.js 的 deriveVisibleItems',
      change_intent: '修正过滤谓词的边界条件',
    }, ctx)
    expect(approved.output).toContain('已批准')
    const writeAfter = await byName(tools, 'write_file').execute(
      { path: 'src/store.js', content: 'const s = 1\n' },
      ctx,
    )
    expect(writeAfter.isError).toBeFalsy()
    // 通配符/超量 → 拒绝「不能申请全项目可写」
    const wildcard = await byName(tools, 'repair_control').execute({
      action: 'request_scope_expansion',
      issue_id: 'F-005',
      requested_paths: ['src/*'],
      reason: 'x',
      change_intent: 'y',
    }, ctx)
    expect(wildcard.isError).toBe(true)
    expect(wildcard.output).toContain('不能申请全项目可写')
    // 受保护路径 → 拒绝
    const protectedDeny = await byName(tools, 'repair_control').execute({
      action: 'request_scope_expansion',
      issue_id: 'F-005',
      requested_paths: ['prd.json'],
      reason: 'x',
      change_intent: 'y',
    }, ctx)
    expect(protectedDeny.isError).toBe(true)
    expect(protectedDeny.output).toContain('受保护')
    // 缺必填 → 用法错误
    const missing = await byName(tools, 'repair_control').execute({
      action: 'request_scope_expansion',
      issue_id: 'F-005',
    }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.output).toContain('必填字段')
    // report_blocker → 记录 + 结构化确认
    const blocker = await byName(tools, 'repair_control').execute({
      action: 'report_blocker',
      blocker_reason: '预览沙箱反复重启，测试环境不稳定',
      evidence: 'run_gwt_tests 连续 3 次 ECONNREFUSED',
    }, ctx)
    expect(blocker.output).toContain('受阻已记录')
    expect(scope.blockers).toHaveLength(1)
    expect(scope.blockers[0]!.reason).toContain('沙箱')
    // 账本：3 次申请（批准 1 + 拒 2）
    expect(scope.expansions).toHaveLength(3)
    expect(scope.expansions.filter((e) => e.decision === 'approved')).toHaveLength(1)
  })
})
