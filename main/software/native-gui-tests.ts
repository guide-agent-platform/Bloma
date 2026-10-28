import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import ts from 'typescript';
import { getPromaHome } from '../../storage/config-paths';
import type { GuiAcceptanceSuite } from '../desktop/gui-acceptance';
import { nativeTestInputs } from './native-test-inputs';
export interface NativeGuiTests {
    layout?: 'project';
    entry: string;
    directory: string;
    digest: string;
    contract: string;
    restart: boolean;
    cases: Array<{
        name: string;
        feature: string;
        signature: string;
    }>;
    files: Array<{
        path: string;
        sha256: string;
        size: number;
        support?: string;
    }>;
}
export function sameNativeTestBytes(a: NativeGuiTests, b: NativeGuiTests) {
    return a.layout === b.layout && a.entry === b.entry && a.directory === b.directory && a.restart === b.restart
        && a.files.length === b.files.length && a.files.every((f, i) => f.path === b.files[i].path && f.sha256 === b.files[i].sha256 && f.size === b.files[i].size);
}
export class NativeTestContractError extends Error {
    constructor(public readonly paths: string[]) {
        super(`GUI_EXISTING_EXPECTATIONS_CHANGED: ${JSON.stringify({ paths: paths.slice(0, 24), omitted: Math.max(0, paths.length - 24), next: '开发探针可自由修改；正式案例保留已执行的业务输入、断言和共享业务逻辑。未执行的引导计划可依据宿主失败凭据修复。' })}`);
    }
}
/** Compare business contracts, allowing extra checks and layout-only migration.
 * Support logic/fixture bytes remain semantic because they can change inputs. */
export function nativeTestContractChanges(before: NativeGuiTests, after: NativeGuiTests, retained?: Set<string>): string[] {
    if (sameNativeTestBytes(before, after)) return [];
    const source = (native: NativeGuiTests, file: string) => native.layout === 'project' ? file : native.directory + '/' + file;
    const paths: string[] = [];
    if (source(before, before.entry) !== source(after, after.entry)) paths.push('entry');
    if (before.restart && !after.restart) paths.push('restart');
    for (const c of before.cases) if ((!retained || retained.has(c.feature)) && !after.cases.some(n => n.name === c.name && n.feature === c.feature && n.signature === c.signature)) paths.push(`case:${c.feature}:${c.name}`);
    for (const f of before.files) {
        const match = after.files.find(n => source(after, n.path) === source(before, f.path));
        if (!match || (f.support ?? f.sha256) !== (match.support ?? match.sha256)) paths.push(source(before, f.path));
    }
    return paths;
}
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function isNativeGuiTestModule(path: string) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let native = false;
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:test')
            native = true;
        if (ts.isFunctionLike(node) && node.parameters?.[0] && ts.isObjectBindingPattern(node.parameters[0].name)
            && node.parameters[0].name.elements.some(e => (e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName.text : ts.isIdentifier(e.name) ? e.name.text : '') === 'test'))
            native = true;
        ts.forEachChild(node, visit);
    };
    visit(file);
    return native;
}
function safe(path: string) {
    if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]|[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)))
        throw Error('GUI_NATIVE_PATH_INVALID');
    return path;
}
function base(projectId: string, digest: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId) || !/^[a-f0-9]{64}$/.test(digest))
        throw Error('GUI_NATIVE_ID_INVALID');
    let root = getPromaHome();
    for (const part of ['gui-native-tests', projectId, digest]) {
        root = join(root, part);
        if (existsSync(root) && lstatSync(root).isSymbolicLink())
            throw Error('GUI_NATIVE_LINK_UNSUPPORTED');
        mkdirSync(root, { recursive: true });
    }
    return root;
}
function fileWithin(root: string, path: string) {
    safe(path);
    let file = root;
    for (const part of path.split('/')) {
        file = join(file, part);
        if (existsSync(file) && lstatSync(file).isSymbolicLink())
            throw Error('GUI_NATIVE_LINK_UNSUPPORTED');
    }
    return file;
}
export function validateNativeGuiTests(value: NativeGuiTests) {
    if (!value || value.layout !== undefined && value.layout !== 'project' || typeof value.restart !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.digest) || !/^[a-f0-9]{64}$/.test(value.contract)
        || !Array.isArray(value.cases) || !value.cases.length || new Set(value.cases.map(c => c.name)).size !== value.cases.length || value.cases.some(c => !c.name || !/^F-\d+$/.test(c.feature) || !/^[a-f0-9]{64}$/.test(c.signature))
        || !Array.isArray(value.files) || !value.files.length || value.files.length > 1000 || Buffer.byteLength(JSON.stringify(value)) > 96 * 1024)
        throw Error('GUI_NATIVE_SUITE_INVALID');
    safe(value.entry);
    if (value.layout !== 'project' || value.directory !== '.') safe(value.directory);
    if (!value.files.some(f => f.path === value.entry) || new Set(value.files.map(f => f.path)).size !== value.files.length)
        throw Error('GUI_NATIVE_FILES_INVALID');
    let bytes = 0;
    for (const file of value.files) {
        safe(file.path);
        if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.support !== undefined && !/^[a-f0-9]{64}$/.test(file.support) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 8 * 1024 * 1024 || (bytes += file.size) > 32 * 1024 * 1024)
            throw Error('GUI_NATIVE_FILES_INVALID');
    }
    if (sha(JSON.stringify(value.files)) !== value.digest)
        throw Error('GUI_NATIVE_DIGEST_INVALID');
    if (sha(JSON.stringify({ ...(value.layout ? { layout: value.layout } : {}), entry: value.entry, directory: value.directory, restart: value.restart, cases: value.cases, files: value.files.map(f => ({ path: f.path, semantic: f.support ?? f.sha256 })) })) !== value.contract)
        throw Error('GUI_NATIVE_CONTRACT_INVALID');
}
export function freezeNativeGuiTests(projectId: string, root: string, script: string, covers: string[], restart = false): NativeGuiTests {
    safe(script);
    if (!/\.(?:m|c)?js$/i.test(script))
        throw Error('GUI_NATIVE_JS_REQUIRED');
    const directory = dirname(script).replaceAll('\\', '/');
    if (directory !== '.') safe(directory);
    const testRoot = realpathSync(root), selected = nativeTestInputs(testRoot, script);
    const files: NativeGuiTests['files'] = [], contents = new Map<string, Buffer>(), ids = new Set<string>(), cases: NativeGuiTests['cases'] = [];
    let bytes = 0, reopened = false;
        for (const path of selected) {
            const file = fileWithin(testRoot, path);
            safe(path);
            if (lstatSync(file).isSymbolicLink())
                throw Error('GUI_NATIVE_LINK_UNSUPPORTED');
            const size = lstatSync(file).size;
            if (size > 8 * 1024 * 1024 || (bytes += size) > 32 * 1024 * 1024 || files.length >= 1000)
                throw Error('GUI_NATIVE_SIZE_LIMIT');
            const data = readFileSync(file);
            if (data.length !== size)
                throw Error('GUI_NATIVE_INPUT_CHANGED');
            const descriptor: NativeGuiTests['files'][number] = { path, sha256: sha(data), size };
            files.push(descriptor);
            contents.set(path, data);
            if (/\.(?:m|c)?js$/i.test(path)) {
                const parsed = ts.createSourceFile(path, data.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                if ((parsed as unknown as {
                    parseDiagnostics: unknown[];
                }).parseDiagnostics.length)
                    throw Error(`GUI_NATIVE_SYNTAX_INVALID:${path}`);
                const names = new Set(['test', 'it']);
                parsed.forEachChild(node => {
                    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:test') {
                        const bindings = node.importClause?.namedBindings;
                        if (bindings && ts.isNamedImports(bindings))
                            for (const spec of bindings.elements)
                                if (['test', 'it'].includes(spec.propertyName?.text ?? spec.name.text))
                                    names.add(spec.name.text);
                    }
                });
                const isCase = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node)
                    && (ts.isIdentifier(node.expression) && names.has(node.expression.text) || ts.isPropertyAccessExpression(node.expression)
                        && (node.expression.name.text === 'test' || ts.isIdentifier(node.expression.expression) && names.has(node.expression.expression.text) && ['skip', 'todo', 'only'].includes(node.expression.name.text)))
                    && Boolean(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]));
                const locatorMethods = new Set(['locator', 'getByRole', 'getByLabel', 'getByPlaceholder', 'getByText', 'getByTestId', 'getByTitle', 'filter', 'first', 'last', 'nth']), roots = new Set(['page']);
                const locator = (n: ts.Node): boolean => ts.isIdentifier(n) ? roots.has(n.text) : ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && locatorMethods.has(n.expression.name.text) && locator(n.expression.expression);
                const aliases = (n: ts.Node) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && locator(n.initializer))
                    roots.add(n.name.text); ts.forEachChild(n, aliases); };
                aliases(parsed);
                // Only pure locator values are replaceable. Calls or assignments hidden
                // inside a selector argument must remain part of the frozen logic.
                const pure = (n: ts.Node): boolean => ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) || ts.isRegularExpressionLiteral(n)
                    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(n.kind)
                    || ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && pure(n.left) && pure(n.right)
                    || ts.isObjectLiteralExpression(n) && n.properties.every(p => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && pure(p.initializer))
                    || ts.isArrayLiteralExpression(n) && n.elements.every(pure)
                    || ts.isCallExpression(n) && n.arguments.every(pure) && locator(n);
                const waitOptions = (n: ts.Node): boolean => ts.isObjectLiteralExpression(n) && n.properties.every(p =>
                    ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && ['timeout', 'waitUntil'].includes(p.name.getText(parsed).replace(/['"]/g, ''))
                    && (p.name.getText(parsed).replace(/['"]/g, '') === 'timeout'
                        ? ts.isNumericLiteral(p.initializer) && Number(p.initializer.text) >= 100 && Number(p.initializer.text) <= 30000
                        : ts.isStringLiteral(p.initializer) && ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(p.initializer.text)));
                const normalize = (node: ts.Node, removeCases = false) => {
                    const transformed = ts.transform(node, [context => {
                            const visit: ts.Visitor = n => {
                                if (removeCases && ts.isExpressionStatement(n)) {
                                    const exp = ts.isAwaitExpression(n.expression) ? n.expression.expression : n.expression;
                                    if (isCase(exp) && ((exp.arguments[0] as ts.StringLiteralLike).text.match(/\bF-\d+\b/g) ?? []).length === 1)
                                        return undefined;
                                }
                        // Enabling a previously skipped/todo case is safe. The
                        // host still rejects any declaration that did not run.
                        if(isCase(n)&&ts.isPropertyAccessExpression(n.expression)&&['skip','todo','only'].includes(n.expression.name.text))
                            return ts.factory.updateCallExpression(n,n.expression.expression,n.typeArguments,n.arguments.map(arg=>ts.visitNode(arg,visit) as ts.Expression))
                                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && locatorMethods.has(n.expression.name.text) && locator(n.expression.expression) && n.arguments.every(pure))
                                    return ts.factory.updateCallExpression(n, ts.visitNode(n.expression, visit) as ts.Expression, n.typeArguments, [ts.factory.createStringLiteral('[locator]')]);
                                // Navigation destinations and wait states remain semantic;
                                // only literal timing/readiness options may be adapted.
                                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(parsed) === 'page'
                                    && ['goto', 'waitForLoadState'].includes(n.expression.name.text) && n.arguments.length === 2 && waitOptions(n.arguments[1]))
                                    return ts.factory.updateCallExpression(n, n.expression, n.typeArguments, [n.arguments[0], ts.factory.createStringLiteral('[wait-options]')]);
                                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(parsed) === 'page'
                                    && n.expression.name.text === 'waitForTimeout' && n.arguments.length === 1 && ts.isNumericLiteral(n.arguments[0])
                                    && Number(n.arguments[0].text) >= 100 && Number(n.arguments[0].text) <= 30000)
                                    return ts.factory.updateCallExpression(n, n.expression, n.typeArguments, [ts.factory.createStringLiteral('[bounded-wait]')]);
                                return ts.visitEachChild(n, visit, context);
                            };
                            return root => ts.visitNode(root, visit) as typeof root;
                        }]);
                    try {
                        return ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, transformed.transformed[0], parsed);
                    }
                    finally {
                        transformed.dispose();
                    }
                };
                const walk = (node: ts.Node) => {
                    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind)
                        && [node.left, node.right].some(n => ts.isStringLiteralLike(n) && n.text === 'reopened')
                        && [node.left, node.right].some(n => ts.isIdentifier(n) && n.text === 'phase' || ts.isPropertyAccessExpression(n) && n.name.text === 'phase'))
                        reopened = true;
                    if (isCase(node)) {
                        const name = (node.arguments[0] as ts.StringLiteralLike).text, tags = name.match(/\bF-\d+\b/g) ?? [];
                        if (tags.length > 1)
                            throw Error('GUI_NATIVE_CASE_FEATURE_REQUIRED: 每个业务测试名称标注一个F编号，可为同功能写多项测试');
                        if (tags.length) {
                            ids.add(tags[0]!);
                            cases.push({ name, feature: tags[0]!, signature: sha(normalize(node)) });
                        }
                    }
                    ts.forEachChild(node, walk);
                };
                walk(parsed);
                descriptor.support = sha(normalize(parsed, true));
            }
        }
    if (covers.some(id => !ids.has(id)) || [...ids].some(id => !covers.includes(id)))
        throw Error(`GUI_NATIVE_COVERAGE_REQUIRED: 用node:test测试名称覆盖${covers.join(',')}，未知编号不接受`);
    restart = restart || reopened;
    const entry = script;
    const contract = sha(JSON.stringify({ layout: 'project', entry, directory, restart, cases, files: files.map(f => ({ path: f.path, semantic: f.support ?? f.sha256 })) }));
    const value: NativeGuiTests = { layout: 'project', directory, entry, files, cases, contract, restart, digest: sha(JSON.stringify(files)) };
    validateNativeGuiTests(value);
    const destination = base(projectId, value.digest);
    for (const item of files) {
        if (sha(readFileSync(join(testRoot, item.path))) !== item.sha256)
            throw Error('GUI_NATIVE_INPUT_CHANGED');
        const target = fileWithin(destination, item.path);
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target)) {
            if (lstatSync(target).isSymbolicLink() || sha(readFileSync(target)) !== item.sha256)
                throw Error('GUI_NATIVE_FROZEN_INPUT_CHANGED');
        }
        else
            writeFileSync(target, contents.get(item.path)!, { flag: 'wx', mode: 0o600 });
    }
    return value;
}
export function frozenNativeGuiVersion(projectId: string, native?: NativeGuiTests, sourceRoot?: string): string | undefined {
    if (!native)
        return;
    validateNativeGuiTests(native);
    const directory = base(projectId, native.digest);
    for (const file of native.files) {
        const frozen = fileWithin(directory, file.path);
        if (lstatSync(frozen).isSymbolicLink() || lstatSync(frozen).size !== file.size || sha(readFileSync(frozen)) !== file.sha256)
            throw Error('GUI_NATIVE_FROZEN_INPUT_CHANGED');
        if (sourceRoot) {
            const source = fileWithin(sourceRoot, native.layout === 'project' ? file.path : native.directory + '/' + file.path);
            if (!existsSync(source) || lstatSync(source).isSymbolicLink() || sha(readFileSync(source)) !== file.sha256)
                throw Error('GUI_NATIVE_TEST_SOURCE_CHANGED: 输入和预期已冻结；定位修复可重新verify_app(script)，不能改断言过关');
        }
    }
    return native.digest;
}
export function frozenNativeGuiEntry(projectId: string, native: NativeGuiTests, sourceRoot: string) {
    frozenNativeGuiVersion(projectId, native, sourceRoot);
    return join(base(projectId, native.digest), native.entry);
}
export function frozenNativeGuiRoot(projectId: string, native: NativeGuiTests, sourceRoot: string) {
    frozenNativeGuiVersion(projectId, native, sourceRoot);
    return base(projectId, native.digest);
}
export function nativeGuiObservations(suite: GuiAcceptanceSuite, reports: Array<{
    code: number;
    events: string;
    trace: string;
}>) {
    const steps: Array<{
        id: string;
        passed: boolean;
        actual: unknown;
    }> = [], covered = new Set<string>(), executed = new Set<string>();
    let interactions = 0, assertions = 0, failed = false;
    const bootstrapErrors: string[] = [];
    for (const report of reports) {
        if (report.code !== 0)
            failed = true;
        const trace = JSON.parse(report.trace);
        if (!Number.isSafeInteger(trace.interactions) || trace.interactions < 0 || !Number.isSafeInteger(trace.assertions) || trace.assertions < 0 || !Array.isArray(trace.cases))
            throw Error('GUI_NATIVE_TRACE_INVALID');
        interactions += trace.interactions;
        assertions += trace.assertions;
        for (const line of report.events.split(/\r?\n/).filter(Boolean)) {
            const event = JSON.parse(line);
            if (!['test:pass', 'test:fail'].includes(event.type))
                continue;
            const ids = String(event.name).match(/\bF-\d+\b/g) ?? [];
            if (event.type === 'test:fail' && !ids.length && event.error) bootstrapErrors.push(String(event.error));
            if (ids.some((id: string) => !suite.covers.includes(id)))
                throw Error('GUI_NATIVE_UNKNOWN_REQUIREMENT');
            const observed = trace.cases.find((c: {
                name: string;
                assertions: number;
            }) => c.name === event.name && Number.isSafeInteger(c.assertions) && c.assertions > 0);
            const passed = event.type === 'test:pass' && !event.skip && !event.todo && Boolean(observed);
            if (ids.length && !suite.native_tests!.cases.some(c => c.name === event.name))
                throw Error('GUI_NATIVE_UNDECLARED_CASE');
            if (event.type === 'test:fail')
                failed = true;
            if (ids.length) {
                if (passed) {
                    ids.forEach((id: string) => covered.add(id));
                    executed.add(event.name);
                }
                steps.push({ id: `native-${steps.length + 1}`, passed, actual: { test: event.name, error: event.error, assertion: event.assertion } });
            }
        }
    }
    const missing = suite.covers.filter(id => !covered.has(id));
    const finish=<T>(value:T)=>({...value,native_evidence:{interactions,assertions}})
    if (!steps.length && !assertions && failed && bootstrapErrors.length) return finish({ status: 'unverified' as const, steps,
        error: `GUI_NATIVE_BOOTSTRAP_FAILED: ${bootstrapErrors[0].slice(0, 4000)}` });
    if(!assertions&&steps.length&&steps.every(step=>!step.passed&&String((step.actual as {error?:string}).error).includes('GUI_NATIVE_ASSERTION_REQUIRED')))return finish({status:'unverified' as const,steps,error:'GUI_NATIVE_ASSERTIONS_MISSING: 没有实际业务断言，需修正测试计划，不能据此交付'})
    if (failed && steps.some(step => !step.passed))
        return finish({ status: 'failed' as const, steps, error: '原生应用测试的真实断言失败，见测试结果' });
    if (suite.native_tests!.cases.some(c => !executed.has(c.name)))
        return finish({ status: 'unverified' as const, steps, error: 'GUI_NATIVE_CASE_NOT_RUN: 仍有声明的业务测试未执行或被跳过' });
    if (!steps.length || !interactions || !assertions || missing.length)
        return finish({ status: 'unverified' as const, steps, error: `GUI_NATIVE_EVIDENCE_INCOMPLETE: 未通过覆盖${missing.join(',') || '或缺少真实交互/断言'}` });
    return finish({ status: failed ? 'failed' as const : 'passed' as const, steps, ...(failed ? { error: '原生应用测试失败，见实际断言结果' } : {}) });
}
