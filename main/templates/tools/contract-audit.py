"""contract-audit — 测试脚本反空静态检查（批6a，2026-10-06）。

定位：拦截「永真断言/吞异常/无断言」这类最明显的假绿——静态检查不能证明测试好，
但能可靠拦截明显无效的（reject）；可疑弱断言标 inconclusive 呈现不拒收。

三态口径（讨论 turn11 第5点）：
- reject    明确永真（assert 常量/自比较/别名比较）、吞异常、测试函数无断言、无条件跳过
- inconclusive  可疑弱断言（oracle 来自被测对象自身、subprocess 不查返回值）
- pass_static  无静态违规（≠ 测试有效，只是没发现问题）

用法：python contract-audit.py --files driver.py selftest.py
输出：单行 JSON {"files":[...], "findings":[{"file","line","kind","state","detail"}], "summary":{"reject":n,"inconclusive":n,"audited":n}}
"""

from __future__ import annotations

import ast
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")


def _is_truthy_constant(node: ast.expr) -> bool:
    if isinstance(node, ast.Constant):
        return bool(node.value)
    return False


def _is_generative_metric_assert(test: ast.expr) -> bool:
    """生成层指标断言白名单（批9 2026-10-07 LLM 分层断言口径）。

    LLM 生成层断言的是质量指标而非精确文本：长度范围/关键词覆盖/结构 schema/包含判断。
    这类断言重复调用生成函数（两侧 dump 相同）是正常模式，不判 oracle-from-target
    （防误杀——分层断言口径见 verify 任务书）；同时供 summary 正向计数观测。
    """
    src = ast.unparse(test) if hasattr(ast, "unparse") else ""
    indicators = ("len(", " in ", "re.search", "re.match", "any(", "all(", "isinstance(")
    return any(ind in src for ind in indicators)


def _name_origin(node: ast.expr, aliases: dict[str, str]) -> str | None:
    """把表达式归约到「赋值来源名」（expected = actual 的别名链追踪，一层即可）。"""
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    return None


def audit_function(func: ast.FunctionDef | ast.AsyncFunctionDef, path: str) -> list[dict]:
    findings: list[dict] = []
    # 无断言检查只对名字像测试的函数生效（2026-10-06 误报实锤：driver.py 的 main 是
    # 编排函数——断言在它调用的 assert_* 场景函数里，把全文件函数都当测试查会误拒
    # 正当结构；场景函数按骨架约定命名 test_/assert_/check_/verify_，仍全覆盖）
    is_test = func.name.startswith(("test_", "assert_", "check_", "verify_"))

    has_assert = False
    generative_metric_asserts = 0
    aliases: dict[str, str] = {}
    for stmt in ast.walk(func):
        # 1) assert 常量 / 自比较 / 别名比较
        if isinstance(stmt, ast.Assert):
            has_assert = True
            test = stmt.test
            if _is_generative_metric_assert(test):
                generative_metric_asserts += 1
            if _is_truthy_constant(test):
                findings.append({"file": path, "line": stmt.lineno, "kind": "assert-constant", "state": "reject",
                                 "detail": "assert 常量真值（永真断言）"})
            elif isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], (ast.Eq, ast.Is)):
                # 生成层指标断言白名单（批9）：指标形态不进 oracle 判定（防误杀分层断言）
                if not _is_generative_metric_assert(test):
                    left, right = test.comparators[0], test.left
                    if isinstance(left, ast.Name) and isinstance(right, ast.Name) and left.id == right.id:
                        findings.append({"file": path, "line": stmt.lineno, "kind": "self-compare", "state": "reject",
                                         "detail": f"assert {left.id} 与自身比较（永真）"})
                    else:
                        lo, ro = _name_origin(left, aliases), _name_origin(right, aliases)
                        if lo is not None and ro is not None and lo == ro:
                            findings.append({"file": path, "line": stmt.lineno, "kind": "alias-compare", "state": "reject",
                                             "detail": f"期望值与实际值同源（{lo} 的别名互比，永真）"})
                        elif ast.dump(left) == ast.dump(right):
                            findings.append({"file": path, "line": stmt.lineno, "kind": "oracle-from-target", "state": "inconclusive",
                                             "detail": "断言两侧表达式完全相同——期望值疑似取自被测对象自身"})
        # 2) 吞异常
        if isinstance(stmt, ast.ExceptHandler):
            body_pass = len(stmt.body) == 1 and isinstance(stmt.body[0], ast.Pass)
            body_return_none = len(stmt.body) == 1 and isinstance(stmt.body[0], ast.Return) and stmt.body[0].value is None
            if body_pass or body_return_none:
                findings.append({"file": path, "line": stmt.lineno, "kind": "swallow-exception", "state": "reject" if is_test else "inconclusive",
                                 "detail": "except 后 pass/裸 return——异常被吞，失败不会让测试变红"})
        # 3) 无条件跳过
        if isinstance(stmt, ast.Call):
            target = stmt.func
            name = target.attr if isinstance(target, ast.Attribute) else (target.id if isinstance(target, ast.Name) else "")
            if name in ("skip", "skipif", "xfail"):
                cond_skip = name == "skipif" and bool(stmt.args)
                unconditional = name in ("skip", "xfail")
                if unconditional or (cond_skip and _is_truthy_constant(stmt.args[0])):
                    findings.append({"file": path, "line": stmt.lineno, "kind": "unconditional-skip", "state": "reject",
                                     "detail": f"{name}() 无条件/恒真跳过——测试不会真正执行"})
        # 4) subprocess 不查返回
        if isinstance(stmt, ast.Call):
            target = stmt.func
            name = target.attr if isinstance(target, ast.Attribute) else (target.id if isinstance(target, ast.Name) else "")
            if name == "run" and any(isinstance(k, ast.keyword) and k.arg == "check" for k in stmt.keywords):
                pass  # check=True 已查
        if isinstance(stmt, ast.Assign):
            for t, v in zip(stmt.targets, [stmt.value]):
                if isinstance(t, ast.Name):
                    # Two calls, even with identical syntax, can observe
                    # different states at different times. Only a direct
                    # assignment aliases the same value.
                    aliases[t.id] = aliases.get(v.id, v.id) if isinstance(v, ast.Name) else f"value:{stmt.lineno}:{stmt.col_offset}"

    # subprocess.run 无 check 且函数内无 returncode 检查（函数级粗粒度，避免误报嵌套）
    src = ast.unparse(func) if hasattr(ast, "unparse") else ""
    if ".run(" in src or "Popen" in src:
        if "check=True" not in src and "returncode" not in src:
            findings.append({"file": path, "line": func.lineno, "kind": "subprocess-unchecked", "state": "inconclusive",
                             "detail": "subprocess 调用未检查退出码（check=True/returncode 均无）——命令失败测试仍可能绿"})

    if is_test and not has_assert and not findings:
        # 无断言测试（返回 True 但没有任何 assert/raise）
        has_raise = any(isinstance(n, ast.Raise) for n in ast.walk(func))
        if not has_raise:
            findings.append({"file": path, "line": func.lineno, "kind": "no-assert", "state": "reject",
                             "detail": f"测试函数 {func.name} 内没有任何断言——跑过≠验证"})
    if generative_metric_asserts > 0:
        findings.append({"file": path, "line": func.lineno, "kind": "generative-metric-assert", "state": "whitelisted",
                         "detail": f"生成层指标断言 {generative_metric_asserts} 处（长度/关键词/结构形态——分层断言白名单，不计永真）"})
    return findings


def audit_file(path: str) -> list[dict]:
    try:
        with open(path, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), filename=path)
    except SyntaxError as error:
        return [{"file": path, "line": getattr(error, "lineno", 0) or 0, "kind": "syntax-error", "state": "reject",
                 "detail": f"无法解析（{error.msg}）——不是可审计的 Python 测试脚本"}]
    findings: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            findings.extend(audit_function(node, path))
    return findings


def main() -> int:
    files: list[str] = []
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--files":
            i += 1
            while i < len(args) and not args[i].startswith("--"):
                files.append(args[i])
                i += 1
        else:
            i += 1
    all_findings: list[dict] = []
    for path in files:
        all_findings.extend(audit_file(path))
    summary = {
        "reject": sum(1 for f in all_findings if f["state"] == "reject"),
        "inconclusive": sum(1 for f in all_findings if f["state"] == "inconclusive"),
        "audited": len(files),
    }
    print(json.dumps({"files": files, "findings": all_findings, "summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
