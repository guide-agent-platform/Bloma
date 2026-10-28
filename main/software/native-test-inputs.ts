import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import ts from 'typescript'

/** Snapshot the test's reachable inputs, not every unrelated file in tests/.
 * Optional native-inputs.json lists project-relative assets with dynamic paths.
 * This is static preparation: project code is never imported/executed here. */
export function nativeTestInputs(root: string, script: string): string[] {
  const absolute = realpathSync(root), files = new Set<string>()
  let bytes = 0
  const within = (file: string) => {
    const rel = relative(absolute, file).replaceAll('\\', '/')
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.split('/').includes('node_modules')) throw Error('GUI_NATIVE_DEPENDENCY_OUTSIDE_PROJECT')
    let cursor = absolute
    for (const part of rel.split('/')) {
      cursor = join(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw Error('GUI_NATIVE_LINK_UNSUPPORTED')
    }
    return rel
  }
  const visit = (file: string) => {
    const name = within(file)
    if (files.has(name)) return
    if (!existsSync(file) || !lstatSync(file).isFile()) throw Error(`GUI_NATIVE_DEPENDENCY_MISSING: ${name}`)
    const size = lstatSync(file).size
    if (files.size >= 1000 || size > 8 * 1024 * 1024 || (bytes += size) > 32 * 1024 * 1024) throw Error('GUI_NATIVE_SIZE_LIMIT')
    files.add(name)
    if (!/\.(?:m|c)?js$/i.test(file)) return
    const parsed = ts.createSourceFile(name, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const request = (specifier: string, asset = false) => {
      if (specifier.length > 2048) throw Error(`GUI_NATIVE_DEPENDENCY_INVALID: ${name}`)
      if (isBuiltin(specifier)) return
      if (!specifier.startsWith('.')) {
        if (asset || isAbsolute(specifier) || specifier.includes(':')) throw Error(`GUI_NATIVE_DEPENDENCY_OUTSIDE_PROJECT: ${name}`)
        try { createRequire(file).resolve(specifier) }
        catch (error) {
          // require.resolve uses CommonJS export conditions. An installed
          // import-only package must be resolved by the real ESM loader later.
          if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw Error(`GUI_NATIVE_PACKAGE_MISSING: ${JSON.stringify({ file: name, specifier, next: '按项目锁文件安装测试支持依赖；不执行或重写业务断言。' })}`)
        }
        return
      }
      const target = resolve(dirname(file), specifier)
      within(target)
      let resolved: string
      try { resolved = asset ? target : createRequire(file).resolve(specifier) }
      catch { throw Error(`GUI_NATIVE_DEPENDENCY_MISSING: ${JSON.stringify({ file: name, specifier, next: '补齐实际测试支持模块；动态夹具可在native-inputs.json中列出工程相对路径。' })}`) }
      visit(resolved)
    }
    const walk = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) request(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        && (ts.isIdentifier(node.expression) && node.expression.text === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword)) request(node.arguments[0].text)
      const parent = node.parent
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[1]?.getText(parsed) === 'import.meta.url' && parent && ts.isCallExpression(parent)
        && /(?:^|\.)(?:readFileSync|readFile|openSync|createReadStream)$/.test(parent.expression.getText(parsed))) request(node.arguments[0].text, true)
      ts.forEachChild(node, walk)
    }
    walk(parsed)
  }
  visit(resolve(root, script))
  const manifest = join(root, dirname(script), 'native-inputs.json')
  if (existsSync(manifest)) {
    if (lstatSync(manifest).isSymbolicLink() || lstatSync(manifest).size > 65536) throw Error('GUI_NATIVE_INPUTS_INVALID')
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as { files?: unknown }
    if (!Array.isArray(value.files) || value.files.length > 1000 || value.files.some(f => typeof f !== 'string' || !f || isAbsolute(f) || f.includes('\\') || f.split('/').some(p => !p || p === '.' || p === '..'))) throw Error('GUI_NATIVE_INPUTS_INVALID')
    visit(manifest)
    for (const file of value.files as string[]) visit(resolve(root, file))
  }
  return [...files].sort()
}
