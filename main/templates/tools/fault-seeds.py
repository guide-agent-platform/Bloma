"""fault-seeds — 语义故障种子（批6b，2026-10-06）：AST 确定性变换 + 备份/恢复。

定位：变异测试的语义化子集——不做随机变异，只做 tkinter 桌面工具最常见的四类
「已知坏」注入（等价变异率远低于随机变异）；平台在 verify 收口对 P0 验收点
逐点注入并复跑驱动：测试仍绿 = survived（测试没证明任何东西）→ 硬拒收。

种子（定位策略按 tkinter 惯例，按源码序取首个命中——确定性）：
- FS-VALIDATION-REMOVE  删除首个「if not/空值校验 → return/raise」分支（必填校验失守）
- FS-SAVE-NOP           写文件函数体→pass（保存变空操作；open(w)/write/json.dump/to_csv/savefig）
- FS-BUTTON-NOP         command= 回调函数体→pass（按钮点了没反应；无引用时回退 on_*/handle_* 命名）
- FS-STATE-INVERT       校验函数 return True/False 取反（成功失败状态互换）

用法：
  python fault-seeds.py --file app.py --seed FS-SAVE-NOP --apply   # 注入（自动备份 .bloma-fault.bak）
  python fault-seeds.py --file app.py --restore                    # 从备份恢复
输出：单行 JSON {"applied":bool,"reason"?:str,"function"?:str,"line"?:int} / {"restored":bool}
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BAK_SUFFIX = ".bloma-fault.bak"
SEEDS = ("FS-VALIDATION-REMOVE", "FS-SAVE-NOP", "FS-BUTTON-NOP", "FS-STATE-INVERT")


def _body_writes_files(func: ast.FunctionDef) -> bool:
    for node in ast.walk(func):
        if isinstance(node, ast.Call):
            target = node.func
            name = target.attr if isinstance(target, ast.Attribute) else (target.id if isinstance(target, ast.Name) else "")
            if name in ("write", "dump", "to_csv", "to_excel", "savefig", "save", "writelines"):
                return True
            if name == "open" and any(isinstance(k, ast.keyword) and k.arg == "mode" and isinstance(k.value, ast.Constant) and "w" in str(k.value.value) for k in node.keywords):
                return True
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in ("w", "wb", "a"):
            # open(path, "w") 位置参数形态
            return True
    return False


def _is_validation_if(stmt: ast.If) -> bool:
    """if not X / if X in (None,'',..) / if not X: 且 body 是 return/raise。"""
    test = stmt.test
    is_not = isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not)
    is_falsy_cmp = isinstance(test, ast.Compare) and any(
        isinstance(op, (ast.In, ast.Eq)) for op in test.ops
    )
    if not (is_not or is_falsy_cmp):
        return False
    body_ok = stmt.body and isinstance(stmt.body[0], (ast.Return, ast.Raise))
    return body_ok


def _command_handlers(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.keyword) and node.arg == "command" and isinstance(node.value, ast.Name):
            names.add(node.value.id)
    return names


class _StripValidation(ast.NodeTransformer):
    def __init__(self) -> None:
        self.done = False

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.FunctionDef:
        if not self.done:
            new_body = []
            removed_at = None
            for stmt in node.body:
                if not self.done and isinstance(stmt, ast.If) and _is_validation_if(stmt):
                    removed_at = stmt.lineno
                    self.done = True
                    continue  # 整个 if 分支删除
                new_body.append(stmt)
            if self.done:
                if not new_body or not isinstance(new_body[-1], (ast.Return, ast.Raise, ast.Pass)):
                    new_body.append(ast.Pass())
                node.body = new_body
                node.bloma_marker = removed_at  # type: ignore[attr-defined]
        return node


def apply_seed(source: str, seed: str) -> tuple[str | None, dict]:
    tree = ast.parse(source)

    def first_function(predicate) -> ast.FunctionDef | None:
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and predicate(node):
                return node
        return None

    if seed == "FS-VALIDATION-REMOVE":
        target = first_function(lambda f: any(isinstance(s, ast.If) and _is_validation_if(s) for s in f.body))
        if target is None:
            return None, {"applied": False, "reason": "not-applicable：未找到 if not/空值校验→return/raise 形态"}
        marker = {"line": 0}

        class Stripper(_StripValidation):
            def visit_FunctionDef(self, node):
                result = super().visit_FunctionDef(node)
                if getattr(node, "bloma_marker", None) and not marker["line"]:
                    marker["line"] = node.bloma_marker
                return result

        new_tree = Stripper().visit(tree)
        if not marker["line"]:
            return None, {"applied": False, "reason": "not-applicable：校验分支定位失败"}
        return ast.unparse(new_tree), {"applied": True, "function": target.name, "line": marker["line"]}

    if seed == "FS-SAVE-NOP":
        target = first_function(_body_writes_files)
        if target is None:
            return None, {"applied": False, "reason": "not-applicable：未找到写文件函数"}
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == target.name:
                node.body = [ast.Pass()]
        return ast.unparse(tree), {"applied": True, "function": target.name, "line": target.lineno}

    if seed == "FS-BUTTON-NOP":
        handlers = _command_handlers(tree)
        target = first_function(lambda f: f.name in handlers) if handlers else first_function(
            lambda f: f.name.startswith(("on_", "handle_")) and f.name.endswith(("_click", "_press", "_tap"))
        )
        if target is None:
            return None, {"applied": False, "reason": "not-applicable：未找到 command= 回调函数"}
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == target.name:
                node.body = [ast.Pass()]
        return ast.unparse(tree), {"applied": True, "function": target.name, "line": target.lineno}

    if seed == "FS-STATE-INVERT":
        def has_bool_return(func: ast.FunctionDef) -> bool:
            return any(
                isinstance(n, ast.Return) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, bool)
                for n in ast.walk(func)
            )

        target = first_function(has_bool_return)
        if target is None:
            return None, {"applied": False, "reason": "not-applicable：未找到返回 True/False 的校验函数"}

        class Inverter(ast.NodeTransformer):
            def __init__(self, fname: str) -> None:
                self.fname = fname
                self.line = 0

            def visit_FunctionDef(self, node):
                self.generic_visit(node)
                if node.name == self.fname:
                    for stmt in ast.walk(node):
                        if isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, bool):
                            stmt.value = ast.Constant(value=not stmt.value.value)
                            self.line = self.line or stmt.lineno
                return node

        inv = Inverter(target.name)
        new_tree = inv.visit(tree)
        if not inv.line:
            return None, {"applied": False, "reason": "not-applicable：布尔返回定位失败"}
        return ast.unparse(new_tree), {"applied": True, "function": target.name, "line": inv.line}

    return None, {"applied": False, "reason": f"unknown-seed：{seed}（合法：{'/'.join(SEEDS)}）"}


def main() -> int:
    args = sys.argv[1:]
    flags: set[str] = set()
    opts: dict[str, str] = {}
    value_flags = {"file", "seed"}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("--"):
            key = arg[2:]
            if key in value_flags and i + 1 < len(args):
                opts[key] = args[i + 1]
                i += 2
            else:
                flags.add(key)
                i += 1
        else:
            i += 1
    file_arg = opts.get("file")
    if not file_arg:
        print(json.dumps({"applied": False, "reason": "missing --file"}, ensure_ascii=False))
        return 0
    path = Path(file_arg)

    if "restore" in flags:
        bak = path.with_name(path.name + BAK_SUFFIX)
        if bak.exists():
            bak.replace(path)
            print(json.dumps({"restored": True, "file": str(path)}, ensure_ascii=False))
        else:
            print(json.dumps({"restored": False, "reason": "no-backup"}, ensure_ascii=False))
        return 0

    seed = opts.get("seed", "")
    if "apply" not in flags or seed not in SEEDS:
        print(json.dumps({"applied": False, "reason": f"用法：--file f --seed <{'/'.join(SEEDS)}> --apply"}, ensure_ascii=False))
        return 0

    source = path.read_text(encoding="utf-8")
    bak = path.with_name(path.name + BAK_SUFFIX)
    if bak.exists():
        print(json.dumps({"applied": False, "reason": "backup-exists（上次注入未恢复，先 --restore）"}, ensure_ascii=False))
        return 0
    mutated, info = apply_seed(source, seed)
    if mutated is None:
        print(json.dumps(info, ensure_ascii=False))
        return 0
    bak.write_text(source, encoding="utf-8")
    path.write_text(mutated, encoding="utf-8")
    print(json.dumps({**info, "seed": seed, "file": str(path)}, ensure_ascii=False))
    return 0


sys.exit(main())
