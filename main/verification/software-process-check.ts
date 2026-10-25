import ts from 'typescript'
import { resolve } from 'node:path'
import type { SecurityIssue } from './security-scan'

/** Narrow source check for command injection, not a process sandbox or a proof
 * of whole-program safety. Ordinary native tools and HTTPS are software APIs. */
export function softwareProcessIssues(source: string, file: string): SecurityIssue[] {
  if (!/child_process|\beval\b|\bFunction\b|document\.write/.test(source)) return []
  const name = resolve(file), options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, noEmit: true }
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.JS)
  const host = ts.createCompilerHost(options); host.getSourceFile = filename => resolve(filename) === name ? tree : undefined
  const checker = ts.createProgram([name], options, host).getTypeChecker(), symbol = (node: ts.Node) => checker.getSymbolAtLocation(node)
  const namespaces = new Set<ts.Symbol>(), functions = new Map<ts.Symbol, string>(), values = new Map<ts.Symbol, ts.Expression[]>()
  const processModule = (node: ts.Node | undefined) => !!node && ts.isStringLiteralLike(node) && ['child_process', 'node:child_process'].includes(node.text)
  const required = (node: ts.Node | undefined) => !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && processModule(node.arguments[0])
  const walk = (node: ts.Node, visit: (node: ts.Node) => void) => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
  walk(tree, node => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const binding = symbol(node.name)
        if (binding) { values.set(binding, [...(values.get(binding) ?? []), node.initializer]); if (required(node.initializer)) namespaces.add(binding) }
      } else if (ts.isObjectBindingPattern(node.name) && required(node.initializer)) {
        for (const item of node.name.elements) if (ts.isIdentifier(item.name) && symbol(item.name)) functions.set(symbol(item.name)!, item.propertyName?.getText(tree).replace(/["']/g, '') ?? item.name.text)
      }
    }
    if (ts.isImportDeclaration(node) && processModule(node.moduleSpecifier)) {
      const clause = node.importClause
      if (clause?.name && symbol(clause.name)) namespaces.add(symbol(clause.name)!)
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) && symbol(clause.namedBindings.name)) namespaces.add(symbol(clause.namedBindings.name)!)
      else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) if (symbol(item.name)) functions.set(symbol(item.name)!, item.propertyName?.text ?? item.name.text)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && symbol(node.left)) {
      const binding = symbol(node.left)!; values.set(binding, [...(values.get(binding) ?? []), node.right])
    }
  })
  walk(tree, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isPropertyAccessExpression(node.initializer)
      && (required(node.initializer.expression) || ts.isIdentifier(node.initializer.expression) && symbol(node.initializer.expression) && namespaces.has(symbol(node.initializer.expression)!)) && symbol(node.name)) {
      functions.set(symbol(node.name)!, node.initializer.name.text)
    }
  })
  const literal = (node: ts.Expression | undefined, seen = new Set<ts.Symbol>()): string | undefined => {
    if (!node) return
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isIdentifier(node)) {
      const binding = symbol(node), initializers = binding && !seen.has(binding) ? values.get(binding) : undefined
      if (binding && initializers?.length === 1) return literal(initializers[0], new Set([...seen, binding]))
    }
  }
  const untrusted = (node: ts.Node, seen = new Set<ts.Symbol>()): boolean => {
    if (ts.isIdentifier(node)) {
      const binding = symbol(node), initializers = binding && !seen.has(binding) ? values.get(binding) : undefined
      if (binding && initializers?.length) return initializers.some(value => untrusted(value, new Set([...seen, binding])))
      if (/^(?:req|request|userInput|userCommand|userCode|input|query|body)$/i.test(node.text)) return true
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(tree) === 'process' && node.name.text === 'argv') return true
    let found = false; ts.forEachChild(node, child => { if (untrusted(child, seen)) found = true }); return found
  }
  const issues: SecurityIssue[] = []
  walk(tree, node => {
    const dynamicFunction = (ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Function' && !symbol(node.expression)
    const dynamicEval = ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text === 'eval' && !symbol(node.expression)
      || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'eval' && ['globalThis', 'window', 'global'].includes(node.expression.expression.getText(tree)))
    const documentWrite = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(tree) === 'document' && ['write', 'writeln'].includes(node.expression.name.text)
    if ((dynamicFunction || dynamicEval || documentWrite) && (node as ts.CallExpression | ts.NewExpression).arguments?.some(argument => literal(argument) === undefined)) {
      issues.push({ severity: 'critical', category: 'dangerous_execution', file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        user_visible_summary: '动态文本被作为代码或页面脚本执行，请改为显式逻辑或安全文本渲染' })
    }
    if (!ts.isCallExpression(node)) return
    let name: string | undefined
    if (ts.isIdentifier(node.expression) && symbol(node.expression)) name = functions.get(symbol(node.expression)!)
    else if (ts.isPropertyAccessExpression(node.expression) && (required(node.expression.expression)
      || ts.isIdentifier(node.expression.expression) && symbol(node.expression.expression) && namespaces.has(symbol(node.expression.expression)!))) name = node.expression.name.text
    if (!name || !['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(name)) return
    const [command, args, options] = node.arguments
    let unsafe = false
    if (name === 'exec' || name === 'execSync') unsafe = literal(command) === undefined || untrusted(command)
    else {
      const option = [args, options].find(value => value && ts.isObjectLiteralExpression(value))
      const shell = option && ts.isObjectLiteralExpression(option) && option.properties.some(item => ts.isPropertyAssignment(item)
        && item.name.getText(tree).replace(/["']/g, '') === 'shell' && item.initializer.kind === ts.SyntaxKind.TrueKeyword)
      if (shell) unsafe = [command, args].filter(Boolean).some(value => untrusted(value)) || literal(command) === undefined
      const executable = literal(command)?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase()
      if (executable && ['cmd', 'powershell', 'pwsh', 'sh', 'bash'].includes(executable) && args && ts.isArrayLiteralExpression(args)) {
        const index = args.elements.findIndex(item => ts.isExpression(item) && ['-c', '/c', '-command', '-encodedcommand'].includes((literal(item) ?? '').toLowerCase()))
        if (index >= 0) {
          const program = args.elements[index + 1]
          unsafe ||= !program || !ts.isExpression(program) || literal(program) === undefined || args.elements.slice(index + 1).some(item => untrusted(item))
        }
      }
    }
    if (unsafe) issues.push({ severity: 'critical', category: 'dangerous_execution', file,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      user_visible_summary: '系统命令由动态文本或用户输入拼接进shell；请改用固定可执行文件与参数数组，并验证输入范围' })
  })
  return issues
}
