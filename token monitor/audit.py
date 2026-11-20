import hashlib
import json
import math
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock, Thread
from time import monotonic, time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener, urlopen

from usage import collect

CONFIG = json.loads(Path(__file__).with_name("audit-config.json").read_text(encoding="utf-8-sig"))
OLLAMA = "http://127.0.0.1:11434"


class AuditBatchError(Exception):
    pass


RULES = [(category, *(re.compile(pattern, re.ASCII) if pattern else None for pattern in patterns))
         for category, patterns in CONFIG["rules"].items()]


def needs_audit(row):
    evidence = row["evidence"]
    groups = set()
    for tool in evidence["tools"]:
        category = next((category for category, name, target in RULES
                         if (name and name.search(tool["name"].lower()))
                         or (target and target.search(tool["target"].lower()))), None)
        if category:
            groups.add(category)
    classified = bool(groups) or row["phase"] in CONFIG["phaseCategories"]
    resolved = bool(evidence["failure"]) or any(tool["state"] in ("ok", "failed") for tool in evidence["tools"])
    return not classified or not resolved


def readable_summary(value):
    text = value.strip() if isinstance(value, str) else ""
    return "" if re.search(r'[�\r\n]|^[\[{`]|"(?:exit_code|stderr|stdout)"\s*:', text) else text[:180]


def needs_summary(row):
    evidence = row["evidence"]
    return (not readable_summary(row.get("finding", {}).get("failureSummary"))
            and (bool(evidence["failure"]) or any(tool["state"] == "failed" for tool in evidence["tools"])))


def has_audit_evidence(row):
    evidence = row["evidence"]
    return bool(evidence["text"].strip()) or any(
        tool["target"].strip() or tool["result"].strip() or tool.get("diagnostic", "").strip()
        or tool["name"] not in ("", "工具调用") for tool in evidence["tools"])


def audit_disposition(row, mode):
    if row["status"] == "running":
        return "running"
    if row.get("finding") and not needs_summary(row):
        return "cached"
    if mode == "retry" and not row.get("auditError"):
        return "excluded"
    if mode == "pending" and row.get("auditError"):
        return "unknown"
    if mode == "pending" and not needs_summary(row) and not needs_audit(row):
        return "rule"
    return "queued" if has_audit_evidence(row) else "noEvidence"


def audit_messages(selected, timeline, compact=False):
    subjects = {turn["id"]: {"subject": turn["request"], "order": i}
                for i, turn in enumerate(timeline, 1)}
    turns = {}
    requests = []
    for i, row in enumerate(selected, 1):
        key = row["turn"][2]
        subject = subjects.get(key)
        if subject and key not in turns:
            turns[key] = {"id": len(turns) + 1, **subject}
        ev = row["evidence"]
        tools = sorted(ev["tools"], key=lambda tool: tool["state"] != "failed")[:2 if compact else 4]
        observed = {"text": ev["text"], "failure": ev["failure"], "retries": row.get("retries", [])[:4],
                    "tools": [{"name": t["name"][:80], "target": t["target"], "state": t["state"],
                               "result": (t.get("diagnostic") or t["result"])[:480 if j == 0 else 120]}
                              for j, t in enumerate(tools)]}
        request = {"id": i, "phase": row["phase"], "explainFailure": needs_summary(row),
                   "observed": {name: value for name, value in observed.items() if value}}
        if key in turns:
            request["turnId"] = turns[key]["id"]
        requests.append(request)
    extra_turns = [turn for turn in timeline if turn["id"] not in turns]
    context = [] if compact else extra_turns
    if not compact and len(extra_turns) > 6:
        first_request_at = min(row["at"] for row in selected)
        preceding = [turn for turn in extra_turns if turn["at"] < first_request_at][-2:]
        sampled_ids = {turn["id"] for turn in extra_turns[:2] + preceding + extra_turns[-2:]}
        context = [turn for turn in extra_turns if turn["id"] in sampled_ids]
    session = {"totalTurns": len(timeline), "omittedTurns": len(extra_turns) - len(context),
               "context": [{"order": subjects[turn["id"]]["order"], "subject": turn["request"][:80],
                            **({"reply": turn["reply"][:100]} if turn["reply"] else {})}
                           for turn in context]}
    messages = [{"role": "system", "content": CONFIG["system"]},
            {"role": "user", "content": json.dumps({"categories": CONFIG["categories"],
               "outcomes": CONFIG["outcomes"], "session": session, "turns": list(turns.values()), "requests": requests},
               ensure_ascii=False, separators=(",", ":"))}]
    if not compact and len(selected) == 1 and input_bytes(messages) > CONFIG["auditInputBytes"]:
        return audit_messages(selected, timeline, compact=True)
    return messages


def input_bytes(messages):
    return len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def session_batches(rows, timeline):
    by_turn = {}
    for row in rows:
        by_turn.setdefault(row["turn"][2], []).append(row)
    batches, batch = [], []
    def fits(items):
        return (len(items) <= CONFIG["auditBatchSize"]
                and input_bytes(audit_messages(items, timeline)) <= CONFIG["auditInputBytes"])

    for group in by_turn.values():
        if batch and not fits(batch + group):
            batches.append(batch)
            batch = []
        for row in group:
            if batch and not fits(batch + [row]):
                batches.append(batch)
                batch = []
            batch.append(row)
    if batch:
        batches.append(batch)
    return batches


def unreadable_failure_summary(row):
    for tool in row["evidence"]["tools"]:
        output = tool.get("diagnostic") or tool["result"]
        if tool["state"] == "failed" and "�" in output:
            if row["evidence"]["failure"]:
                return row["evidence"]["failure"] + "。"
            code = re.search(r'"exit_code"\s*:\s*(-?\d+)', output)
            action = "创建目录失败" if re.search(r"\bmkdir\b", tool["target"], re.I) else "命令执行失败" if code else "工具执行失败"
            return action + (f"（退出码 {code[1]}）" if code else "") + "。错误输出无法读取，具体原因无法确认。"
    return ""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


LOCAL = build_opener(ProxyHandler({}), NoRedirect())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            tmp = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False)
        tmp.replace(path)
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


def fingerprint(row):
    evidence = row["evidence"]
    value = [row["phase"], row["status"], evidence["text"], evidence["source"], evidence["failure"],
             [[t["name"], t["target"], t["result"], t["state"]] for t in evidence["tools"]]]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def cache_path(home, row):
    return home / "token-monitor" / "audit-v1" / row["project"] / (row["id"] + ".json")


def add_findings(home, rows):
    for row in rows:
        row.pop("auditError", None)
        try:
            cached = json.loads(cache_path(home, row).read_text(encoding="utf-8"))
            if cached.get("fingerprint") != fingerprint(row):
                continue
            error = cached.pop("auditError", None)
            if isinstance(error, str) and error:
                row["auditError"] = error
            if (all(isinstance(cached.get(k), str) for k in ("category", "outcome", "purpose", "result", "model"))
                    and cached["category"] in CONFIG["categories"] and cached["outcome"] in CONFIG["outcomes"]):
                row["finding"] = cached
        except (OSError, ValueError, AttributeError, TypeError):
            pass


def local_json(path, data=None):
    request = Request(OLLAMA + path, data=json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if data is not None else None,
                      headers={"Content-Type": "application/json"})
    with LOCAL.open(request, timeout=180 if data is not None else 5) as response:
        return json.load(response)


def batch_items(body):
    try:
        result = local_json("/api/chat", body)
        message = result.get("message") if isinstance(result, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        parsed = json.loads(content) if isinstance(content, str) and content else None
    except HTTPError as error:
        message = f"Ollama HTTP {error.code}"
        if error.code in (401, 403, 404):
            raise ValueError(message) from error
        raise AuditBatchError(message) from error
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        reason = error.reason if isinstance(error, URLError) else error
        if isinstance(reason, TimeoutError):
            raise AuditBatchError("Ollama 响应超时") from error
        if isinstance(reason, ConnectionRefusedError):
            raise ValueError("无法连接 Ollama，请确认本机服务正在运行") from error
        if isinstance(error, (UnicodeError, json.JSONDecodeError)):
            raise AuditBatchError("Ollama 返回的 JSON 无法解析") from error
        raise AuditBatchError("Ollama 请求连接中断") from error
    items = parsed.get("items") if isinstance(parsed, dict) else None
    return {str(item.get("id")): item for item in items if isinstance(item, dict)} if isinstance(items, list) else {}


class LocalAudit:
    def __init__(self, home):
        self.home = home
        self.lock = Lock()
        self.job = None

    def models(self):
        names = [m["name"] for m in local_json("/api/tags").get("models", [])
                 if m.get("name") and not m.get("remote_host") and "cloud" not in m["name"].lower()]
        return list(dict.fromkeys([m for m in CONFIG["preferredModels"] if m in names] + names))

    def status(self):
        with self.lock:
            return dict(self.job) if self.job else None

    def start(self, filters):
        if (not isinstance(filters, dict) or filters.get("mode", "pending") not in ("pending", "all", "retry")
                or ("session" in filters and (not isinstance(filters["session"], str) or not filters["session"].strip()))
                or any(key in filters and (type(filters[key]) not in (int, float) or not math.isfinite(filters[key]))
                       for key in ("start", "end"))):
            raise ValueError("无效的审查参数")
        with self.lock:
            if self.job and self.job["state"] in ("running", "stopping"):
                raise ValueError("本机审查正在运行")
            self.job = {"state": "running", "model": filters.get("model") or "", "processed": 0, "remaining": 0}
            initial = dict(self.job)
        Thread(target=self.run, args=(filters,), daemon=True).start()
        return initial

    def stop(self):
        with self.lock:
            if self.job and self.job["state"] == "running":
                self.job["state"] = "stopping"
            return dict(self.job) if self.job else None

    def run(self, filters):
        try:
            data = collect(self.home)
            add_findings(self.home, data["rows"])
            start, end = filters.get("start"), filters.get("end")
            project, session = filters.get("project"), filters.get("session")
            mode = filters.get("mode", "pending")
            def eligible(row):
                return audit_disposition(row, mode) == "queued"

            scoped = [r for r in data["rows"] if (not project or r["project"] == project) and (start is None or r["at"] >= start)
                      and (session is None or r["turn"][1] == session)
                      and (end is None or r["at"] < end)]
            dispositions = {}
            for row in scoped:
                dispositions.setdefault(audit_disposition(row, mode), []).append(row)
            pending = dispositions.get("queued", [])
            with self.lock:
                self.job["remaining"] = len(pending)
                if "noEvidence" in dispositions:
                    self.job["skippedNoEvidence"] = len(dispositions["noEvidence"])
                if "unknown" in dispositions:
                    self.job["skippedUnknownErrors"] = len(dispositions["unknown"])
                running = self.job["state"] == "running"
            if pending and running:
                models = self.models()
                model = filters.get("model") or next(iter(models), None)
                if not model or model not in models:
                    raise ValueError("Ollama 未安装所选本地模型")
                with self.lock:
                    self.job["model"] = model
                sessions, timelines = {}, {}
                for row in pending:
                    sessions.setdefault(tuple(row["turn"][:2]), []).append(row)
                for turn in data["turns"]:
                    if not turn.get("unlinked"):
                        timelines.setdefault((turn["project"], turn["session"]), []).append(turn)
                for key, requests in sessions.items():
                    if self.status()["state"] != "running":
                        break
                    timeline = sorted(timelines.get(key, []), key=lambda turn: turn["at"])
                    batches = [(batch, False) for batch in session_batches(requests, timeline)]
                    for index, (selected, retry) in enumerate(batches, 1):
                        if self.status()["state"] != "running":
                            break
                        add_findings(self.home, selected)
                        candidates = [row for row in selected if eligible(row)]
                        with self.lock:
                            self.job["remaining"] -= len(selected) - len(candidates)
                        if not candidates:
                            continue
                        messages = audit_messages(candidates, timeline)
                        byte_count = input_bytes(messages)
                        if len(candidates) > 1 and byte_count > CONFIG["auditInputBytes"]:
                            batches[index:index] = [(rows, retry) for rows in session_batches(candidates, timeline)]
                            continue
                        started = monotonic()
                        batch = {"project": key[0], "session": key[1], "index": index, "total": len(batches),
                                 "requests": len(candidates), "inputBytes": byte_count,
                                 "startedAt": int(time() * 1000), "retry": retry}
                        if timeline:
                            batch["title"] = timeline[0]["request"][:60]
                        with self.lock:
                            self.job["activeBatch"] = batch
                        reason = "本地模型返回的分类或失败摘要不完整"
                        deferred = candidates
                        try:
                            deferred = self.classify(candidates, model, messages)
                        except AuditBatchError as error:
                            reason = str(error)
                        except Exception as error:
                            reason = str(error)
                            raise
                        finally:
                            result = {**batch, "elapsedMs": round((monotonic() - started) * 1000), "unresolved": len(deferred)}
                            if deferred:
                                result["error"] = reason
                            with self.lock:
                                history = self.job.get("batchHistory", []) + [result]
                                self.job["batchHistory"] = history[-CONFIG["auditHistoryLimit"]:]
                                self.job.pop("activeBatch", None)
                        with self.lock:
                            self.job["processed"] += len(candidates) - len(deferred)
                            self.job["remaining"] -= len(candidates) - len(deferred)
                        if not deferred:
                            continue
                        if retry:
                            add_findings(self.home, deferred)
                            unresolved = list(filter(eligible, deferred))
                            for row in unresolved:
                                marker = {**row.get("finding", {}), "fingerprint": fingerprint(row), "auditError": reason}
                                write_json(cache_path(self.home, row), marker)
                            with self.lock:
                                if unresolved:
                                    self.job["unknownErrors"] = self.job.get("unknownErrors", 0) + len(unresolved)
                                    self.job["lastAuditError"] = reason
                                self.job["remaining"] -= len(deferred)
                        else:
                            middle = (len(deferred) + 1) // 2
                            for group in (deferred[:middle], deferred[middle:]):
                                batches.extend((rows, True) for rows in session_batches(group, timeline))
            with self.lock:
                self.job["state"] = "stopped" if self.job["remaining"] else "completed"
        except Exception as error:
            with self.lock:
                self.job.update(state="error", error=str(error))

    def classify(self, selected, model, messages):
        body = {"model": model, "stream": False, "think": False, "format": "json", "messages": messages,
                "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 2200}}
        by_id = batch_items(body)
        deferred = []
        for i, row in enumerate(selected, 1):
            item = by_id.get(str(i), {})
            add_findings(self.home, [row])
            existing = row.get("finding")
            missing_summary = needs_summary(row)
            summary = readable_summary((existing or {}).get("failureSummary")) or unreadable_failure_summary(row) or readable_summary(item.get("failureSummary"))
            if missing_summary and not summary:
                deferred.append(row)
                continue
            if not existing and (not isinstance(item.get("category"), str) or not isinstance(item.get("outcome"), str)
                                 or item["category"] not in CONFIG["categories"] or item["outcome"] not in CONFIG["outcomes"]):
                deferred.append(row)
                continue
            if not existing or missing_summary:
                finding = existing or {"category": item["category"], "outcome": item["outcome"], "model": model,
                    "purpose": str(item.get("purpose") or "")[:180], "result": str(item.get("result") or "")[:180],
                    "fingerprint": fingerprint(row)}
                if missing_summary and summary:
                    finding = finding | {"failureSummary": summary, "summaryModel": model}
                write_json(cache_path(self.home, row), finding)
        return deferred


class Exchange:
    def __init__(self, home):
        self.file = home / "token-monitor" / "fx.json"
        self.current = CONFIG["fx"]
        self.lock = Lock()
        try:
            self.set(json.loads(self.file.read_text(encoding="utf-8")))
        except (OSError, ValueError, AttributeError, TypeError):
            pass

    def set(self, data):
        rate, date = data.get("rate"), data.get("date")
        if type(rate) in (int, float) and math.isfinite(rate) and rate > 0 and isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            self.current = data
            return True
        return False

    def refresh(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            with urlopen(CONFIG["fxUrl"], timeout=6.5) as response:
                data = json.load(response)
            if self.set({"rate": data["rates"]["CNY"], "date": data["date"]}):
                write_json(self.file, self.current)
        except (OSError, ValueError, KeyError, TypeError):
            pass
        finally:
            self.lock.release()
