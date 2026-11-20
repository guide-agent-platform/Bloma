import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from urllib.request import Request, urlopen

SOURCES = {
    "OpenAI": "https://developers.openai.com/api/docs/pricing.md",
    "Anthropic": "https://platform.claude.com/docs/en/about-claude/pricing.md",
    "DeepSeek": "https://api-docs.deepseek.com/quick_start/pricing/",
    "Google": "https://aistudio.google.com/docs/pricing.md",
}
KEYS = ("uncached", "read", "write", "output")
BUNDLED = Path(__file__).with_name("pricing.json")


def price(text):
    match = re.match(r"^\s*\$([0-9]+(?:\.[0-9]+)?)\b", text)
    return float(match[1]) if match else None


def rates(uncached, read, write, output):
    return dict(zip(KEYS, (uncached, read, write, output)))


def openai(markdown):
    standard = re.search(r"^### Standard pricing data\s*\n(.*?)(?=^Batch\s*$|^### Batch|\Z)",
                         markdown, re.M | re.S)
    if not standard:
        return {}
    models = {}
    columns = {}
    for line in standard[1].splitlines():
        if not line.startswith("|"):
            continue
        model, *cells = (part.strip() for part in line.strip("|").split("|"))
        if model == "Model":
            columns = {name.lower(): index for index, name in enumerate(cells)}
            continue
        model = re.sub(r"\s*\(.*\)$", "", model)
        if not re.fullmatch(r"(?:gpt-|o[134](?:-|$)|chat-latest$)[\w.-]*", model):
            continue

        def cell(name):
            index = columns.get("short context " + name, columns.get(name))
            return price(cells[index]) if index is not None and index < len(cells) else None

        row = rates(cell("input"), cell("cached input"), cell("30m write"), cell("output"))
        if row["uncached"] is not None and row["output"] is not None:
            models[model] = row
    return models


def anthropic(markdown):
    section = re.search(r"^## Model pricing\s*\n(.*?)(?=^##|\Z)", markdown, re.M | re.S)
    if not section:
        return {}
    models = {}
    for line in section[1].splitlines():
        match = re.match(r"^\|\s*Claude ([\w]+)(?: ([0-9.]+))?[^|]*\|(.+)", line)
        if not match:
            continue
        name = "-".join(filter(None, ("claude", match[1].lower(), (match[2] or "").replace(".", "-"))))
        cells = [price(cell) for cell in match[3].strip("|").split("|")]
        if len(cells) == 5 and all(cell is not None for cell in cells):
            uncached, write, _, read, output = cells
            models[name] = rates(uncached, read, write, output)
    return models


def deepseek(html):
    tables = re.findall(r"<table\b[^>]*>(.*?)</table>", html, re.I | re.S)
    table = next((table for table in tables if "CACHE HIT" in table and "CACHE MISS" in table), "")
    rows = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table, re.I | re.S):
        parts = re.findall(r"<t[hd]\b[^>]*>(.*?)</t[hd]>", row, re.I | re.S)
        rows.append([unescape(re.sub(r"<[^>]+>", " ", cell)).strip() for cell in parts])
    model_row = next((row for row in rows if row and row[0].upper() == "MODEL"), [])[1:]
    models = [match[0] for cell in model_row if (match := re.match(r"deepseek-[\w.-]+", cell, re.I))]
    groups = {}
    metric = None
    for row in rows:
        label = " ".join(row).upper()
        if "CACHE HIT" in label:
            metric = "read"
        elif "CACHE MISS" in label:
            metric = "uncached"
        elif "OUTPUT TOKENS" in label:
            metric = "output"
        tier = next((cell.upper() for cell in row if cell.upper() in ("PEAK", "OFF-PEAK")), None)
        if metric and tier:
            groups[tier, metric] = [price(cell) for cell in row[-len(models):]]
    result = {}
    for index, model in enumerate(models):
        if any(index >= len(groups.get((tier, key), [])) or groups[tier, key][index] is None
               for tier in ("OFF-PEAK", "PEAK") for key in ("uncached", "read", "output")):
            continue
        low = rates(*(groups["OFF-PEAK", key][index] if key != "write" else None for key in KEYS))
        high = rates(*(groups["PEAK", key][index] if key != "write" else None for key in KEYS))
        result[model.lower()] = low | {"peak": high}
    return result


def google(markdown):
    models = {}
    for section in re.split(r"^## ", markdown, flags=re.M)[1:]:
        name = re.search(r'\bid="(gemini-[\w.-]+)"', section.splitlines()[0])
        tab = re.search(r'{% tab title="Standard" %}(.*?){% /tab %}', section, re.S)
        if not name or not tab or re.search(r"image|tts|live|robotics", name[1]):
            continue

        def cell(label):
            match = re.search(r"\* " + label + r"[^\n]*\n\s*\*[^\n]*\n\s*\*([^\n]+)", tab[1], re.I)
            return price(match[1]) if match else None

        row = rates(cell("Input price"), cell("Context caching price"), None, cell("Output price"))
        if row["uncached"] is not None and row["output"] is not None:
            models[name[1]] = row
    return models


PARSERS = {"OpenAI": openai, "Anthropic": anthropic, "DeepSeek": deepseek, "Google": google}
MIN_MODELS = {"OpenAI": 8, "Anthropic": 5, "DeepSeek": 2, "Google": 3}


def download(provider):
    request = Request(SOURCES[provider], headers={"User-Agent": "Bloma-Token-Monitor/1.0"})
    with urlopen(request, timeout=6) as response:
        page = response.read(4_000_000).decode("utf-8")
    models = PARSERS[provider](page)
    if len(models) < MIN_MODELS[provider]:
        raise ValueError("官网价格表未通过校验")
    return models


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Catalog:
    def __init__(self, cache):
        self.cache = cache
        self.lock = Lock()
        self.status = {}
        self.data = json.loads(BUNDLED.read_text(encoding="utf-8-sig"))
        try:
            local = json.loads(cache.read_text(encoding="utf-8"))
            for provider in SOURCES:
                if local.get(provider, {}).get("models"):
                    self.data[provider] = local[provider]
        except (OSError, ValueError, AttributeError):
            pass

    def snapshot(self):
        return {provider: self.data[provider] | self.status.get(provider, {"state": "cached"})
                | {"url": SOURCES[provider]} for provider in SOURCES}

    def refresh(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            def fetch(provider):
                checked = now()
                try:
                    return provider, checked, download(provider), None
                except (OSError, ValueError) as error:
                    return provider, checked, None, str(error)

            changed = False
            with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
                for provider, checked, models, error in pool.map(fetch, SOURCES):
                    if models is None:
                        self.status[provider] = {"state": "cached", "checked": checked, "error": error}
                        continue
                    previous = self.data[provider]
                    live = {name: row | {"as_of": checked} for name, row in models.items()}
                    self.data[provider] = {"as_of": checked, "models": previous["models"] | live}
                    self.status[provider] = {"state": "live", "checked": checked}
                    changed = True
            if changed:
                try:
                    self.save()
                except OSError as error:
                    print(f"无法保存价格缓存：{error}", flush=True)
        finally:
            self.lock.release()

    def save(self):
        self.cache.parent.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.cache.parent, delete=False) as stream:
                temp = Path(stream.name)
                json.dump(self.data, stream, ensure_ascii=False)
            os.replace(temp, self.cache)
        finally:
            if temp and temp.exists():
                temp.unlink()
