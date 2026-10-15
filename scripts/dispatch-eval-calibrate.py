"""Local GUI calibration on a copied reference and explicit semantic faults. No model calls."""
import argparse,hashlib,json,pathlib,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--reference',type=pathlib.Path,required=True);p.add_argument('--python',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--resume',action='store_true');a=p.parse_args()
out=a.out.resolve();out.mkdir(parents=True,exist_ok=a.resume);reference=a.reference.resolve();python=a.python.resolve()
if not python.is_file():raise ValueError('Pinned interpreter missing')
def clone(name,source):
 target=out/'products'/name;shutil.copytree(source,target,ignore=shutil.ignore_patterns('.venv','venv','__pycache__','.git','node_modules','.cache','data'));return target
def edit(root,file,old,new,count=1):
 path=root/file;text=path.read_text(encoding='utf-8');assert text.count(old)==count,(file,old,text.count(old));path.write_text(text.replace(old,new),encoding='utf-8')
if a.resume:
 manifest=json.loads((out/'calibration.json').read_text(encoding='utf-8'));original=out/'products/original';correct=out/'products/corrected-reference'
else:
 original=clone('original',reference);correct=clone('corrected-reference',reference)
 edit(correct,'core/backup.py','from core.model import BusinessError, PRIORITIES','from core.model import BusinessError, PRIORITIES, normalize_due')
 edit(correct,'core/backup.py','        _require(isinstance(row["due"], str),','        normalize_due(row["due"])\n        _require(isinstance(row["due"], str),')
 manifest={'scope':'Finite fixed L2 scenarios only; corrected reference is a calibration fixture, never a model result','reference':str(reference),'reference_files':{},'reference_fix':'Validate calendar date on import; original product untouched','cases':[]}
for file in reference.rglob('*'):
 if file.is_file() and '__pycache__' not in file.parts:
  rel=str(file.relative_to(reference));digest=hashlib.sha256(file.read_bytes()).hexdigest()
  if a.resume:assert manifest['reference_files'][rel]==digest,'Reference changed'
  else:manifest['reference_files'][rel]=digest
def run(name,root,check=None,expected='passed'):
 if any(x['name']==name and x['detected_as_expected'] for x in manifest['cases']):return True
 attempt=name if not (out/'results'/name).exists() else name+'-retry-'+str(len(manifest['cases'])+1)
 dest=out/'results'/attempt;log=out/(attempt+'.log');args=[sys.executable,'-u','-X','utf8','-B','scripts/dispatch-eval-l2.py',str(root),str(dest),'--python',str(python)]
 if check:args+=['--checks',check]
 with log.open('w',encoding='utf-8') as f:r=subprocess.run(args,stdout=f,stderr=subprocess.STDOUT,timeout=900)
 report=json.loads((dest/'review.json').read_text(encoding='utf-8'));checks=[x for x in report['checks'] if not check or x['id']==check]
 ok=r.returncode==0 and all(x['status']==expected for x in checks)
 manifest['cases'].append({'name':name,'product':str(root),'check':check,'expected':expected,'observed':[{k:x.get(k) for k in ['id','status','reason']} for x in checks],'detected_as_expected':ok,'evidence':str(dest/'review.json')})
 (out/'calibration.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({'name':name,'ok':ok}),flush=True)
 return ok
run('original-import-defect',original,'import-atomic-idempotent','failed')
if not run('correct-reference',correct):raise RuntimeError('Correct reference did not satisfy fixed scenarios')
faults=[
 ('trim','add-trim',[('core/model.py','def clean_title(raw: object) -> str:\n    text = str(raw or "").strip()','def clean_title(raw: object) -> str:\n    text = str(raw or "")')]),
 ('toggle-title','toggle-isolation',[('core/model.py','if row["kind"] == "task" and row["id"] == task_id:\n                    row["done"] = flag','if row["kind"] == "task" and row["title"] == self._require_task(records, task_id)["title"]:\n                    row["done"] = flag')]),
 ('delete-title','delete-isolation',[('core/model.py','rows[:] = [row for row in rows if not (row["kind"] == "task" and row["id"] == task_id)]','rows[:] = [row for row in rows if not (row["kind"] == "task" and row["title"] == title)]')]),
 ('status-ignored','filters',[('core/model.py','if status_key == "open" and task["done"]:','if False and status_key == "open" and task["done"]:')]),
 ('lost-restart','restart-persistence',[('core/model.py','self.path = self.data_dir / "records.json"','self.path = self.data_dir / (uuid4().hex + ".json")')]),
 ('duplicate-project','project-names',[('core/model.py','if any(project["name"] == cleaned for project in self._projects(records)):','if False and any(project["name"] == cleaned for project in self._projects(records)):')]),
 ('move-reset','project-assignment-move',[('core/model.py','        if not changes:\n','        if changes.get("project_id", self._require_task(records, task_id)["project_id"]) != self._require_task(records, task_id)["project_id"]:\n            changes.update(priority="low", due="")\n        if not changes:\n')]),
 ('project-cascade','project-delete-guard',[('core/model.py','        if mine:\n','        if False and mine:\n'),('core/model.py','rows[:] = [row for row in rows if not (row["kind"] == "project" and row["id"] == project_id)]','rows[:] = [row for row in rows if not ((row["kind"] == "project" and row["id"] == project_id) or row.get("project_id") == project_id)]')]),
 ('invalid-calendar','priority-calendar',[('core/model.py','    try:\n        parsed = date.fromisoformat(text)','    return text\n    try:\n        parsed = date.fromisoformat(text)')]),
 ('overdue-today','overdue-boundaries',[('core/model.py','and due < today','and due <= today')]),
 ('search-ignored','combined-filters',[('core/model.py','if keyword and keyword not in task["title"].lower():','if False and keyword and keyword not in task["title"].lower():')]),
 ('backup-drops-date','backup-roundtrip',[('core/backup.py','"due": row["due"],\n        }\n        for row in records if row["kind"] == "task"','"due": "",\n        }\n        for row in records if row["kind"] == "task"')]),
 ('import-duplicates','import-atomic-idempotent',[('core/backup.py','if row["id"] in existing_tasks:','if False and row["id"] in existing_tasks:')]),
 ('partial-import','import-atomic-idempotent',[('core/model.py','        backup.validate_backup(payload)','        for incoming in payload.get("tasks", []):\n            if incoming.get("id") == "independent-new-task":\n                self.store.update(lambda rows: rows.append(dict(incoming, kind="task")))\n        backup.validate_backup(payload)')]),
 ('blank-title','empty-rejection',[('ui/app.js','if (!title.trim()) { setField("field-title", true); bad = true; }','if (false) { setField("field-title", true); bad = true; }'),('core/model.py','    if not text:\n        raise BusinessError("标题不能为空白", "title")','    if False:\n        raise BusinessError("标题不能为空白", "title")'),('core/model.py','if not isinstance(row.get("title"), str) or not row["title"].strip():','if False:')]),
]
for name,check,changes in faults:
 if any(x['name']==name and x['detected_as_expected'] for x in manifest['cases']):continue
 mutant=clone(name if not (out/'products'/name).exists() else name+'-retry-'+str(len(manifest['cases'])+1),correct)
 for file,old,new in changes:edit(mutant,file,old,new)
 for py in mutant.rglob('*.py'):compile(py.read_text(encoding='utf-8'),str(py),'exec')
 run(name,mutant,check,'failed')
manifest['complete']=len({x['name'] for x in manifest['cases'] if x['detected_as_expected']})==17
(out/'calibration.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
if not manifest['complete']:raise RuntimeError('Calibration had misses or harness errors; inspect retained evidence')
