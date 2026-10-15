"""This sample's GUI adapter assists Codex review; not a calibrated general scorer.
All mutations use rendered controls; expected business outcomes are frozen externally.
"""
import argparse,copy,datetime,importlib.util,json,os,socket,subprocess,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('replay',Path('scripts/robustness-ui-replay.py').resolve())
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('out',type=Path);p.add_argument('--python',type=Path);p.add_argument('--checks');p.add_argument('--capture',action='store_true');a=p.parse_args()
root=a.root.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=False)
T=datetime.date.today();dates=[(T+datetime.timedelta(days=i)).isoformat() for i in [-1,0,1]]
report={'reviewer':'Codex assisted by sample-specific DOM replay','root':str(root),'date':T.isoformat(),'timezone':time.tzname,'checks':[],'steps':[],'scope':'L2 fixed semantic scenarios; this DOM adapter supports the reference UI, other UIs require separate semantic mapping','version':2}
log=(out/'product.log').open('w',encoding='utf-8');r=None;scenario=None
STATE="""({rows:[...document.querySelectorAll('#task-list .w-row')].map(e=>({id:e.dataset.id,title:e.querySelector('.w-row-name').textContent,done:e.querySelector('input[type=checkbox]').checked,tags:e.querySelector('.w-row-tags').innerText})),count:document.querySelector('#sum-count').textContent,projects:[...document.querySelectorAll('#sel-filter-project option')].filter(e=>e.value).map(e=>({id:e.value,name:e.text})),text:document.body.innerText,formHidden:document.querySelector('#form-card').hidden})"""
def save(): (out/'review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
def js(expression,wait=.25):
 value=r.js(expression);time.sleep(wait);observed=r.js(STATE)
 report['steps'].append({'at':time.time(),'scenario':scenario,'expression':expression,'result':value,'observed':observed});save();return value
def observed():return js(STATE,0)
def fill(id,value,event='input'):
 return js(f"(()=>{{const e=document.getElementById({json.dumps(id)});if(!e)throw Error('ADAPTER_MISSING_CONTROL');e.value={json.dumps(value)};e.dispatchEvent(new Event({json.dumps(event)},{{bubbles:true}}));return e.value}})()")
def click(id):return js(f"document.getElementById({json.dumps(id)}).click()")
def select(id,text):
 value=js(f"[...document.getElementById({json.dumps(id)}).options].find(e=>e.text==={json.dumps(text)})?.value",0)
 if value is None:raise RuntimeError('ADAPTER_OPTION_MISSING:'+text)
 fill(id,value,'change');return value
def new_scenario(name):
 global r,scenario,port
 if r:r.close()
 scenario=name;data=out/'data'/name;data.mkdir(parents=True,exist_ok=False)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']=f'--remote-debugging-port={port} --remote-debugging-address=127.0.0.1'
 r=m.Replay(root,data,log,{'ready':"document.readyState==='complete' && !!document.querySelector('#btn-project-add')"},python=a.python);r.start();time.sleep(.4);observed()
def project(name='工作'):fill('inp-project-name',name);click('btn-project-add')
def clear_filters():
 fill('inp-search','');fill('sel-status','all','change');fill('sel-filter-project','','change');fill('sel-filter-priority','','change')
 if js("document.getElementById('chk-overdue').checked",0):click('chk-overdue')
def task(title,project_name='工作',priority='中',due=''):
 before={x['id'] for x in observed()['rows']};click('btn-task-new');fill('inp-task-title',title);select('sel-task-project',project_name);select('sel-task-priority',priority);fill('inp-task-due',due);click('btn-task-save')
 rows=observed()['rows'];added=[x for x in rows if x['id'] not in before]
 assert len(added)==1,{'expected':'one new task','actual':observed()};return added[0]['id']
def row_action(id,toggle=False):
 selector=f"#task-list .w-row[data-id=\"{id}\"]"+(' input[type=checkbox]' if toggle else '')
 js(f"document.querySelector({json.dumps(selector)}).click()")
def rows(count,done=None):
 s=observed();assert len(s['rows'])==count and int(s['count'])==count,{'expected_count':count,'actual':s}
 if done is not None:assert sum(x['done'] for x in s['rows'])==done,{'expected_done':done,'actual':s}
 return s['rows']
def restart():r.stop();r.start();time.sleep(.4);observed()
def screenshot(name):
 if not a.capture:return
 try:
  result=subprocess.run([str(a.python or root/'.venv/Scripts/python.exe'),str(Path(__file__).with_name('capture-owned-window.py')),str(r.process.pid),str(out/(name+'.png'))],capture_output=True,text=True,encoding='utf-8',timeout=25)
  report['steps'].append({'scenario':scenario,'screenshot':name,'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr[:600]});save()
 except Exception as e:report['steps'].append({'screenshot_error':str(e)});save()
def export(name):
 path=out/(scenario+'-'+name+'.json');fill('inp-backup-path',str(path));click('btn-backup-export');assert path.exists(),observed();return json.loads(path.read_text(encoding='utf-8'))
def imported(path):fill('inp-backup-path',str(path));click('btn-backup-import');observed()
def semantic(data):return {k:sorted(data[k],key=lambda x:x['id']) for k in ['projects','tasks']}
def run(id,fn):
 start=len(report['steps'])
 try:new_scenario(id);fn();status='passed';reason=None
 except AssertionError as e:status='failed';reason=str(e)
 except Exception as e:status='pending';reason=f'{type(e).__name__}: {e}'
 report['checks'].append({'id':id,'status':status,'reason':reason,'step_start':start,'step_end':len(report['steps'])});save();print(json.dumps(report['checks'][-1],ensure_ascii=False),flush=True)
def add_trim():
 project();task('  同名任务  ');assert rows(1)[0]['title']=='同名任务';restart();assert rows(1)[0]['title']=='同名任务'
def empty():
 project();task('基线');baseline=rows(1)
 for value in ['', '   ']:click('btn-task-new');fill('inp-task-title',value);click('btn-task-save');assert rows(1)==baseline;assert '标题不能为空白' in observed()['text'];click('btn-task-cancel')
def toggle():
 project();A=task('同名任务');B=task('同名任务');row_action(A,True);assert {x['id']:x['done'] for x in rows(2)}=={A:True,B:False};row_action(A,True);assert {x['id']:x['done'] for x in rows(2)}=={A:False,B:False}
def filters():
 project();A=task('A');task('B');row_action(A,True);rows(2,1);select('sel-status','未完成');rows(1,0);select('sel-status','已完成');rows(1,1);select('sel-status','全部');rows(2,1)
def delete():
 project();A=task('同名任务');B=task('同名任务');row_action(B,True);row_action(A);click('btn-task-delete');assert rows(1,1)[0]['id']==B;restart();assert rows(1,1)[0]['id']==B
def persistence():
 project();A=task('A');B=task('B');C=task('C');row_action(A);fill('inp-task-title','  改名后  ');click('btn-task-save');row_action(B,True);row_action(C);click('btn-task-delete');before=rows(2,1);restart();after=rows(2,1);assert before==after;assert {x['id']:x['title'] for x in after}=={A:'改名后',B:'B'}
def names():
 project(' 工作 ');task('基线');before=observed()
 assert [x['name'] for x in before['projects']]==['工作']
 for name in ['', '   ','工作',' 工作 ']:project(name);now=observed();assert now['projects']==before['projects'] and now['rows']==before['rows'];assert '失败' in now['text'] or '不能为空' in now['text'] or '重复' in now['text']
def move():
 project();project('生活');A=task('同名任务',due=dates[2],priority='高');B=task('同名任务','生活');row_action(A,True);before={x['id']:x for x in rows(2,1)};row_action(A);select('sel-task-project','生活');click('btn-task-save');after={x['id']:x for x in rows(2,1)};assert after[A]['title']==before[A]['title'] and after[A]['done'] and dates[2] in after[A]['tags'] and '高' in after[A]['tags'] and after[B]==before[B];select('sel-filter-project','工作');rows(0);select('sel-filter-project','生活');rows(2,1)
def guard():
 project();project('生活');A=task('A');select('sel-filter-project','工作');js("document.querySelector('#side-list .w-row[data-id=\"'+document.getElementById('sel-filter-project').value+'\"]').click()");before=observed();click('btn-project-delete');now=observed();assert now['projects']==before['projects'] and now['rows']==before['rows'];assert '任务' in now['text'] and ('不能' in now['text'] or '无法' in now['text']);row_action(A);select('sel-task-project','生活');click('btn-task-save');rows(0);click('btn-project-delete');assert [x['name'] for x in observed()['projects']]==['生活'];clear_filters();assert rows(1)[0]['id']==A
def calendar():
 project();A=task('无日期',priority='低');B=task('闰日',due='2028-02-29');C=task('明天',priority='高',due=dates[2]);before=rows(3);restart();assert rows(3)==before
 assert '2028-02-29' in next(x['tags'] for x in before if x['id']==B) and dates[2] in next(x['tags'] for x in before if x['id']==C)
 for invalid in ['2026-02-30','2027-02-29']:row_action(B);fill('inp-task-due',invalid);click('btn-task-save');assert rows(3)==before;assert '日期' in observed()['text'];click('btn-task-cancel')
 assert '低' in next(x['tags'] for x in before if x['id']==A) and '无截止日期' in next(x['tags'] for x in before if x['id']==A);assert '中' in next(x['tags'] for x in before if x['id']==B);assert '高' in next(x['tags'] for x in before if x['id']==C)
def overdue():
 project();A=task('昨天',due=dates[0]);task('今天',due=dates[1]);task('明天',due=dates[2]);D=task('昨天完成',due=dates[0]);row_action(D,True);click('chk-overdue');assert [x['id'] for x in rows(1,0)]==[A];click('chk-overdue');rows(4,1)
def combined():
 project();project('生活');A=task('Alpha',priority='高',due=dates[0]);task('ALPHA',priority='高',due=dates[1]);C=task('Alpha',priority='低',due=dates[0]);D=task('Alpha',priority='高',due=dates[0]);row_action(D,True);task('Alpha','生活',priority='高',due=dates[0]);task('Beta',priority='高',due=dates[0]);fill('inp-search','aLpHa');select('sel-filter-project','工作');select('sel-status','未完成');select('sel-filter-priority','高');click('chk-overdue');assert [x['id'] for x in rows(1)]==[A];screenshot('combined-filter');clear_filters();rows(6,1)
 fill('inp-search','aLpHa');select('sel-filter-project','工作');select('sel-status','未完成');select('sel-filter-priority','高');click('chk-overdue');row_action(A);select('sel-task-project','生活');click('btn-task-save');rows(0);clear_filters();row_action(C);select('sel-task-priority','高');click('btn-task-save');fill('inp-search','aLpHa');select('sel-filter-project','工作');select('sel-status','未完成');select('sel-filter-priority','高');click('chk-overdue');assert [x['id'] for x in rows(1)]==[C]
def backup():
 project();project('生活');A=task('同名任务',priority='高',due=dates[2]);B=task('同名任务','生活',priority='低');row_action(A,True);original=export('source')
 assert len(original['tasks'])==2 and {p['name'] for p in original['projects']}=={'工作','生活'}
 by_id={t['id']:t for t in original['tasks']};projects={p['id']:p['name'] for p in original['projects']}
 assert by_id[A]['title']==by_id[B]['title']=='同名任务' and by_id[A]['done'] and not by_id[B]['done']
 assert by_id[A]['priority']=='high' and by_id[B]['priority']=='low' and by_id[A]['due']==dates[2] and by_id[B]['due']==''
 assert projects[by_id[A]['project_id']]=='工作' and projects[by_id[B]['project_id']]=='生活'
 source_path=out/(scenario+'-source.json');new_scenario('backup-roundtrip-target');imported(source_path);assert semantic(export('restored'))==semantic(original);rows(2,1);restart();assert semantic(export('restart'))==semantic(original);screenshot('backup-restored')
def import_atomic():
 project();A=task('同名任务',priority='高',due=dates[2]);task('同名任务');base=export('base');task('备份外');baseline=semantic(export('baseline'));extra=copy.deepcopy(base['tasks'][0]);extra['id']='independent-new-task';extra['title']='有效新任务'
 for kind in ['missing-title','invalid-date','conflict']:
  sample=copy.deepcopy(base);sample['tasks'].insert(0,copy.deepcopy(extra))
  if kind=='missing-title':del sample['tasks'][1]['title']
  elif kind=='invalid-date':sample['tasks'][1]['id']='independent-invalid-date';sample['tasks'][1]['due']='2026-02-30'
  else:sample['tasks'][1]['title']='内容冲突'
  file=out/(kind+'.json');file.write_text(json.dumps(sample,ensure_ascii=False),encoding='utf-8');imported(file);message=observed()['text'];assert '失败' in message or '冲突' in message or '错误' in message;assert semantic(export(kind+'-after'))==baseline
  if kind=='conflict':screenshot('conflict-rejected')
 valid=copy.deepcopy(base);valid['tasks'].append(extra);file=out/'valid-merge.json';file.write_text(json.dumps(valid,ensure_ascii=False),encoding='utf-8');imported(file);merged=semantic(export('merged'));assert len(merged['tasks'])==4 and {x['title'] for x in merged['tasks']}=={'同名任务','备份外','有效新任务'};assert sum(x['title']=='同名任务' for x in merged['tasks'])==2;imported(file);assert semantic(export('repeated'))==merged;restart();assert semantic(export('restart'))==merged
try:
 cases=[('add-trim',add_trim),('empty-rejection',empty),('toggle-isolation',toggle),('filters',filters),('delete-isolation',delete),('restart-persistence',persistence),('project-names',names),('project-assignment-move',move),('project-delete-guard',guard),('priority-calendar',calendar),('overdue-boundaries',overdue),('combined-filters',combined),('backup-roundtrip',backup),('import-atomic-idempotent',import_atomic)]
 selected=set(a.checks.split(',')) if a.checks else {id for id,_ in cases}
 if selected-{id for id,_ in cases}:raise ValueError('Unknown check IDs')
 for id,fn in cases:
  if id in selected:run(id,fn)
  else:report['checks'].append({'id':id,'status':'pending','reason':'Not selected in this calibration probe'})
 if datetime.date.today()!=T:
  for c in report['checks']:
   if c['id'] in ['overdue-boundaries','combined-filters']:c.update(status='pending',reason='Date crossed midnight; controlled rerun required')
 report['complete']=all(x['status'] in ['passed','failed'] for x in report['checks']);report['score']=sum(x['status']=='passed' for x in report['checks'])/14 if report['complete'] else None;save()
 manual=[{'id':x['id'],'passed':x['status']=='passed','evidence':str(out/'review.json')} for x in report['checks'] if x['status'] in ['passed','failed']]
 (out/'manual.json').write_text(json.dumps(manual,ensure_ascii=False,indent=2),encoding='utf-8')
finally:
 if r:r.close()
 log.close()
