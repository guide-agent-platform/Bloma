"""Independent frozen L1 checks through rendered WebView controls only."""
import importlib.util
import hashlib
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(r'C:\Users\17359\.codex\worktrees\handoff-recovery-fix\guide-agent-platform-sprint0')
ROOT = Path(r'C:\Users\17359\bex-pv220\pilot-r5a\cohort\G11\agent-workspaces\default-software-builder\generated-projects\42487b23-f6c0-47e5-b46b-f607b105ae7b')
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=False)
DATA = OUT / 'fresh-data'
DATA.mkdir()
SUITE = Path(r'C:\Users\17359\bex-l1q19\evaluator\suite.json')
spec = importlib.util.spec_from_file_location('owned_replay', REPO / 'scripts/robustness-ui-replay.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
suite = json.loads(SUITE.read_text(encoding='utf-8'))
report = {
    'at': datetime.now(timezone.utc).isoformat(), 'run_id': 'production-v2-L1-quick-20261021-r5a-G11',
    'scope': 'independent real WebView2 DOM control actions; no direct business calls; isolated data; full owned process tree restart',
    'suite_sha256': hashlib.sha256(SUITE.read_bytes()).hexdigest(),
    'root': str(ROOT), 'data': str(DATA), 'checks': [], 'steps': [], 'screenshots': [],
    'source_sha256_before': module.digest(ROOT),
}

HELPERS = r'''(() => {
 const visible = e => !!e && !!e.getClientRects().length;
 const rows = () => [...document.querySelectorAll('#task-list article.task')].filter(visible);
 window.__hostL1 = {
  rows: () => rows().map(e => ({id:e.dataset.taskId,title:e.querySelector('.task-title').textContent,done:e.querySelector('[data-action="toggle"]').getAttribute('aria-pressed')==='true',state:e.querySelector('.task-state').textContent})),
  add: text => {const e=document.querySelector('#task-input');e.value=text;e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#btn-add').click();},
  toggle: id => {const e=rows().find(e=>e.dataset.taskId===id);if(!e)throw Error('host selector missing target row');e.querySelector('[data-action="toggle"]').click();},
  delete: id => {const e=rows().find(e=>e.dataset.taskId===id);if(!e)throw Error('host selector missing target row');e.querySelector('[data-action="delete"]').click();},
  filter: view => document.querySelector('.view-btn[data-view="'+(view==='open'?'active':view==='done'?'completed':view)+'"]').click(),
  ready: () => !document.querySelector('#btn-add').disabled,
 };
 return true;
})()'''

def save():
    (OUT / 'review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

with (OUT / 'product.log').open('w',encoding='utf-8') as log:
    replay = module.Replay(ROOT,DATA,log,{'ready': "document.readyState==='complete' && !!document.querySelector('#task-input')"})
    def js(expression):
        value=replay.js(expression)
        report['steps'].append({'at':datetime.now(timezone.utc).isoformat(),'expression':expression,'result':value})
        save()
        return value
    def action(expression):
        js(expression)
        time.sleep(.7)
        deadline=time.monotonic()+8
        while js('window.__hostL1.ready()') is not True:
            if time.monotonic()>deadline: raise TimeoutError('UI action did not settle')
            time.sleep(.2)
    def rows(): return js('window.__hostL1.rows()')
    def capture(name):
        target=OUT/(name+'.png')
        value=json.loads(subprocess.check_output([str(replay.python),str(REPO/'scripts/capture-owned-window.py'),str(replay.process.pid),str(target)],encoding='utf-8',timeout=30))
        report['screenshots'].append(value)
        save()
    def restart():
        old_pid=replay.process.pid
        replay.stop()
        report['steps'].append({'event':'owned_process_tree_stopped','pid':old_pid})
        replay.start()
        time.sleep(.8)
        report['steps'].append({'event':'fresh_product_process','pid':replay.process.pid,'same_data':str(DATA)})
        js(HELPERS)
    def check(check_id,fn):
        try:
            fn()
            result={'id':check_id,'status':'passed'}
        except AssertionError as error:
            result={'id':check_id,'status':'failed','error':str(error)}
        except Exception as error:
            result={'id':check_id,'status':'pending','harness_error':f'{type(error).__name__}: {error}'}
        report['checks'].append(result)
        save()
        print(json.dumps(result,ensure_ascii=True),flush=True)
    state={}
    try:
        replay.start()
        time.sleep(.8)
        js(HELPERS)
        assert rows()==[], 'Isolated first launch is not empty'
        def add_trim():
            action("window.__hostL1.add('  实验同名任务  ')")
            actual=rows()
            assert len(actual)==1 and actual[0]['title']=='实验同名任务' and actual[0]['done'] is False,actual
            state['first']=actual[0]['id']
            restart()
            assert rows()==actual,'Trimmed title changed after restart'
        check('add-trim',add_trim)
        def empty():
            action("window.__hostL1.filter('all')")
            before=rows()
            assert len(before)==1,before
            for title in ['', '   ']:
                action('window.__hostL1.add('+json.dumps(title)+')')
                assert rows()==before,'Empty/space title changed existing list'
        check('empty-rejection',empty)
        def toggle():
            action("window.__hostL1.add('实验同名任务')")
            actual=rows()
            assert len(actual)==2 and actual[0]['id']!=actual[1]['id'],actual
            state['second']=actual[1]['id']
            action('window.__hostL1.toggle('+json.dumps(state['first'])+')')
            completed=rows()
            assert completed[0]['id']==state['first'] and completed[0]['done'] is True,completed
            assert completed[1]==actual[1], 'Other same-title row changed on toggle'
            action('window.__hostL1.toggle('+json.dumps(state['first'])+')')
            assert rows()==actual,'Untoggle did not restore exact original rows'
            action('window.__hostL1.toggle('+json.dumps(state['first'])+')')
            state['mixed']=rows()
            capture('same-title-isolation')
        check('toggle-isolation',toggle)
        def filters():
            expected=state['mixed']
            for view,expected_rows in [('all',expected),('open',[expected[1]]),('done',[expected[0]]),('open',[expected[1]]),('all',expected)]:
                action('window.__hostL1.filter('+json.dumps(view)+')')
                assert rows()==expected_rows,{'view':view,'actual':rows(),'expected':expected_rows}
        check('filters',filters)
        def delete():
            action("window.__hostL1.filter('all')")
            action('window.__hostL1.delete('+json.dumps(state['second'])+')')
            expected=[state['mixed'][0]]
            assert rows()==expected,'Delete changed surviving same-title row'
            restart()
            assert rows()==expected,'Deleted row reappeared or surviving state changed'
            state['after_delete']=expected
        check('delete-isolation',delete)
        def persistence():
            before=rows()
            assert before==state['after_delete'] and before[0]['done'] is True,before
            restart()
            assert rows()==before,'Title/state/deletion did not survive full process restart'
            capture('persisted-final')
        check('restart-persistence',persistence)
        report['final_dom']=js('document.body.innerText')
        report['disk_evidence']={str(p.relative_to(DATA)):p.read_text(encoding='utf-8') for p in DATA.rglob('*.json')}
    except Exception as error:
        report['harness_error']=f'{type(error).__name__}: {error}'
    finally:
        replay.close()
        report['owned_processes_closed']=replay.process is None

observed={c['id'] for c in report['checks']}
report['checks'] += [{'id':c['id'],'status':'pending'} for c in suite['checks'] if c['id'] not in observed]
report['source_sha256_after']=module.digest(ROOT)
report['source_unchanged']=report['source_sha256_before']==report['source_sha256_after']
report['complete']=all(c['status'] in ('passed','failed') for c in report['checks']) and report['source_unchanged']
report['Q']=sum(c['status']=='passed' for c in report['checks'])/6 if report['complete'] else None
report['finished_at']=datetime.now(timezone.utc).isoformat()
save()
(OUT/'manual.json').write_text(json.dumps([{'id':c['id'],'passed':c['status']=='passed','evidence':str(OUT/'review.json')} for c in report['checks'] if c['status'] in ('passed','failed')],ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'complete':report['complete'],'Q':report['Q'],'source_unchanged':report['source_unchanged'],'harness_error':report.get('harness_error')},ensure_ascii=True),flush=True)
