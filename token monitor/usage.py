import json
import re
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime

PHASES = {
    "requirements": "需求", "interface": "界面", "production": "制作",
    "verification": "验证", "delivery": "交付", "unknown": "未归类",
}
ROLES = {
    "brief": "requirements", "ux_sketch": "interface", "ux_visual_design": "interface",
    "orchestrator": "production", "implement": "production", "explore": "production",
    "research": "production", "review": "verification", "gui_acceptance_planner": "verification",
    "acceptance_designer": "verification", "delivery": "delivery",
}
USAGE = {
    "uncached": "input_tokens", "read": "cache_read_input_tokens",
    "write": "cache_creation_input_tokens", "output": "output_tokens",
}
PROVIDERS = {
    "api.openai.com": "OpenAI", "api.anthropic.com": "Anthropic", "api.deepseek.com": "DeepSeek",
    "generativelanguage.googleapis.com": "Google", "api.moonshot.cn": "月之暗面",
    "api.moonshot.ai": "月之暗面", "api.kimi.com": "月之暗面", "opencode.ai": "OpenCode",
    "open.bigmodel.cn": "智谱 AI", "api.minimaxi.com": "MiniMax", "api.minimax.io": "MiniMax",
    "ark.cn-beijing.volces.com": "火山方舟", "api.xiaomimimo.com": "小米 MiMo",
    "token-plan-cn.xiaomimimo.com": "小米 MiMo", "dashscope.aliyuncs.com": "阿里云百炼",
    "dashscope-intl.aliyuncs.com": "阿里云百炼", "token-plan.cn-beijing.maas.aliyuncs.com": "阿里云百炼",
    "openrouter.ai": "OpenRouter",
}


def timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) <= 8.64e15:
        return value
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value)
        return dt.timestamp() * 1000 if dt.tzinfo else None
    except (ValueError, OverflowError):
        return None


def safe_id(value):
    return isinstance(value, str) and re.fullmatch(r"[\w-]+", value, re.ASCII) is not None


def indexed(path, key):
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return [row for row in data.get(key, []) if isinstance(row, dict)]
    except (OSError, ValueError, AttributeError, TypeError):
        return []


def lines(path, issues):
    try:
        with path.open("rb") as stream:
            for line in stream:
                # Ignore a partial line while the producer is appending it.
                if not line.endswith(b"\n") or not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    if not isinstance(row, dict):
                        raise ValueError
                    yield row
                except (ValueError, UnicodeError):
                    issues["malformed"] += 1
    except FileNotFoundError:
        pass
    except OSError:
        issues["unreadable"] += 1


def provider_for(host, channel):
    hostname = host.lower().split("]", 1)[0] + "]" if host.startswith("[") else host.lower().split(":", 1)[0]
    return PROVIDERS.get(hostname, "本地服务" if hostname in ("localhost", "127.0.0.1", "[::1]") else
                         f"自定义端点 · {host}" if host else channel or "未知供应商")


def excerpt(blocks, limit):
    if isinstance(blocks, str):
        parts = [blocks]
    elif isinstance(blocks, list):
        parts = [b["text"] for b in blocks if isinstance(b, dict) and b.get("type") == "text"
                 and isinstance(b.get("text"), str)]
    else:
        return ""
    text = " ".join(" ".join(parts).split())
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def failed_output(content):
    raw = content if isinstance(content, str) else "\n".join(
        b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)
    ) if isinstance(content, list) else ""
    errors = [line for line in re.split(r"\r?\n|\\r\\n|\\n", raw)
              if "�" not in line and "<launching>" not in line and re.search(r"\[err\]|\berror:|requires |exit_code|exitCode=", line, re.I)]
    if errors and len(raw) > 560:
        raw = " ".join([*errors[-4:], raw[:160]])
    return excerpt(raw, 560)


def session_turns(path, project, session, issues):
    turns = []
    replies, results = [], {}
    turn = None
    for message in lines(path, issues):
        at = timestamp(message.get("timestamp"))
        if at is None:
            continue
        role, origin = message.get("role"), message.get("origin")
        content = message.get("content")
        blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
        for block in blocks:
            if block.get("type") == "tool_result" and safe_id(block.get("tool_use_id")):
                results[block["tool_use_id"]] = block
        if role == "user" and origin not in ("system", "agent"):
            turn_id = message.get("client_message_id") or message.get("id")
            if not safe_id(turn_id):
                continue
            turn = {
                "project": project, "session": session, "id": turn_id, "at": at,
                "request": excerpt(message.get("content"), 150) or "附件或空文本消息",
                "reply": "",
            }
            turns.append(turn)
        elif role == "assistant" and origin != "system":
            summary = excerpt(message.get("content"), 220)
            if summary and turn:
                turn["reply"] = summary
            replies.append({"at": at, "text": summary, "tools": [b for b in blocks if b.get("type") == "tool_use"]})
    return sorted(turns, key=lambda item: item["at"]), replies, results


def evidence(end, item, transcript):
    replies, results = transcript
    finish = timestamp(end.get("at"))
    raw_ids = end.get("audit_tool_ids")
    ids = [i for i in raw_ids if safe_id(i)] if isinstance(raw_ids, list) else []
    reply = next((r for r in replies if not r.get("used") and any(t.get("id") in ids for t in r["tools"])), None) if ids else None
    source = "id" if reply else "none"
    if not reply and not ids and finish is not None and end.get("status") == "completed" and end.get("scope") in ("loop", "handoff"):
        started = timestamp(item.get("start", {}).get("at"))
        earliest = max(started if started is not None else finish - 120, finish - 120)
        candidates = [r for r in replies if not r.get("used") and earliest <= r["at"] <= finish + 120]
        if len(candidates) == 1:
            reply, source = candidates[0], "time"
    if reply:
        reply["used"] = True
    calls = reply["tools"] if reply else [{"id": i} for i in ids]
    tools = []
    for call in [t for t in calls if not ids or t.get("id") in ids][:16]:
        result = results.get(call.get("id"))
        args = call.get("input")
        args = args if isinstance(args, dict) else {}
        target = next((args[k] for k in ("path", "file_path", "file", "topic", "command", "pattern", "goal") if args.get(k) is not None), None)
        if isinstance(target, list) and target is args.get("command"):
            target = " ".join(part for part in target if isinstance(part, str))
        summary = excerpt((result or {}).get("content"), 180)
        state = "unknown" if not result or "执行结果未知" in summary else "failed" if result.get("is_error") is True else "ok"
        tools.append({"name": call.get("name") or "工具调用", "target": excerpt(target, 180), "result": summary, "state": state,
                      **({"diagnostic": failed_output(result.get("content"))} if state == "failed" else {})})
    failure = ""
    if end.get("stop_reason") in ("max_tokens", "length"):
        failure = "触及输出上限，响应被截断"
    elif end.get("status") == "cancelled":
        failure = "请求已取消"
    elif end.get("status") in ("failed", "error"):
        statuses = [code for code in item["http"].values() if code >= 400]
        failure = f"HTTP {statuses[-1]}" if statuses else "请求异常结束，日志未记录具体原因"
    return {"text": reply["text"] if reply else "", "tools": tools, "source": source, "failure": failure}


def usage_number(value):
    return value if type(value) is int and 0 <= value <= 2**53 - 1 else None


def collect(home):
    issues = defaultdict(int)
    projects = {p["project_id"]: p.get("name") or p["project_id"]
                for p in indexed(home / "projects.json", "projects") if safe_id(p.get("project_id"))}
    ledgers = list((home / "usage-ledger").glob("*.jsonl"))
    by_session = {}
    turn_index = {}
    sessions = {s["session_id"]: s["project_id"] for s in indexed(home / "bloma-agent-sessions.json", "sessions")
                if safe_id(s.get("session_id")) and safe_id(s.get("project_id")) and not s.get("parent_session_id")}
    queries = {}
    for path in ledgers:
        for record in lines(path, issues):
            event = record.get("event")
            if event not in ("query_started", "query_finished", "transport_started", "transport_finished", "transport_response"):
                continue
            project, query, session = (record.get(k) for k in ("project_id", "query_id", "session_id"))
            if record.get("version") != 1 or not all(map(safe_id, (project, query, session))):
                issues["malformed"] += 1
                continue
            projects.setdefault(project, "未分配项目" if project == "unassigned" else project)
            sessions.setdefault(session, project)
            item = queries.setdefault((project, query), {"attempts": set(), "failed": {}, "http": {}})
            if event == "query_started":
                item["start"] = record
            elif event == "query_finished":
                item["end"] = record
            elif type(record.get("transport_index")) is int:
                if event == "transport_started":
                    item["attempts"].add(record["transport_index"])
                elif event == "transport_response":
                    response = record.get("response")
                    if isinstance(response, dict) and type(response.get("status")) is int:
                        item["http"][record["transport_index"]] = response["status"]
                elif record.get("status") != "completed":
                    item["failed"][record["transport_index"]] = record.get("status") or ""

    transcripts = {}
    for session, project in sessions.items():
        turns, replies, results = session_turns(home / "agent-sessions" / f"{session}.jsonl", project, session, issues)
        transcripts[(project, session)] = (replies, results)
        by_session[(project, session)] = ([t["at"] for t in turns], turns)
        for turn in turns:
            turn_index[(project, session, turn["id"])] = turn

    rows = []
    run_turns = {}
    ordered = sorted(queries.items(), key=lambda pair: timestamp((pair[1].get('start') or pair[1].get('end') or {}).get('at')) or 0)
    for (project, query), item in ordered:
        start, end = item.get("start", {}), item.get("end", {})
        record = start | end
        at = timestamp(start.get("at", end.get("at")))
        if at is None:
            issues["malformed"] += 1
            continue
        session = record["session_id"]
        conversation = record.get("parent_session_id") or session
        run_id = record.get("run_id")
        turn_id = record.get("turn_id") or run_id
        exact = (project, conversation, turn_id)
        inferred = False
        if exact in run_turns:
            exact, inferred = run_turns[exact]
        elif exact not in turn_index:
            run_key = exact
            dates, turns = by_session.get((project, conversation), ([], []))
            # Legacy requests can lack a client message ID. Use the last user message
            # before the run started, within a short window, and label the association.
            index = bisect_right(dates, at) - 1
            if index >= 0 and at - dates[index] <= 120_000:
                exact = (project, conversation, turns[index]["id"])
                inferred = True
            else:
                exact = (project, conversation, f"run-{turn_id or query}")
                turn_index.setdefault(exact, {
                    "project": project, "session": conversation, "id": exact[-1],
                    "at": at, "request": "该请求未关联到会话消息", "reply": "", "unlinked": True,
                })
                turn_index[exact]["at"] = min(turn_index[exact]["at"], at)
            if turn_id:
                run_turns[run_key] = (exact, inferred)
        role = record.get("role")
        explicit_phase = record.get("phase")
        if not isinstance(explicit_phase, str):
            explicit_phase = ""
        phase = explicit_phase if explicit_phase in PHASES else ROLES.get(role, "unknown")
        host = record.get("endpoint_host") or ""
        channel = record.get("provider_type") or ""
        usage = end.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        counts = {key: usage_number(usage.get(raw)) for key, raw in USAGE.items()}
        retries = [{"index": i, "status": status, **({"http": item["http"][i]} if i in item["http"] else {})}
                   for i, status in item["failed"].items()]
        rows.append({
            "id": query, "project": project, "session": session, "turn": list(exact),
            "inferred": inferred, "at": at, "phase": phase,
            "phase_inferred": explicit_phase not in PHASES and phase != "unknown",
            "provider": provider_for(host, channel), "host": host, "channel": channel,
            "model": record.get("model") or "未知模型", "counts": counts,
            "status": end.get("status", "unknown") if end else "running",
            "missing": counts["uncached"] is None or counts["output"] is None,
            "attempts": len(item["attempts"]), "failed": len(item["failed"]),
            "retries": retries, "evidence": evidence(end, item, transcripts.get((project, session), ([], {}))),
        })
    projects.update({turn["project"]: projects.get(turn["project"], turn["project"]) for turn in turn_index.values()})
    return {"projects": projects, "rows": rows, "turns": list(turn_index.values()), "issues": dict(issues)}
