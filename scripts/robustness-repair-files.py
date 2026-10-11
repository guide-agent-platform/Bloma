"""One targeted repair in a named workspace variant; no changes to the source case."""
from pathlib import Path
import shutil
import sys

repo = Path(__file__).resolve().parents[1]
root = Path(sys.argv[1]).resolve()
if not root.is_relative_to(repo / 'run-artifacts') or not (root / 'variant-source.json').is_file():
    raise ValueError('Explicit preserved test variant required')
app_path = root / 'app.py'
app = app_path.read_text(encoding='utf-8')
anchor = '        if plan is None:\n            plan = self.preview(folder, prefix)'
if app.count(anchor) != 1:
    raise ValueError('Expected single preview execution point not found')
app = app.replace(anchor, anchor + '\n        from file_plan_guard import validate_prefix_plan\n        plan = validate_prefix_plan(folder, prefix, plan)')
app_path.write_text(app, encoding='utf-8')
shutil.copyfile(repo / 'main/templates/tools/file_plan_guard.py', root / 'file_plan_guard.py')
ui_path = root / 'ui/index.html'
ui = ui_path.read_text(encoding='utf-8')
replacements = [
    ('plan: null, running:', 'plan: null, planInput: null, previewSequence: 0, running:'),
    ('  async function refreshPreview() {', '  async function refreshPreview() {\n    var sequence = ++state.previewSequence;\n    state.plan = null; state.planInput = null; elExecute.disabled = true;'),
    ('      var plan = await App.call("preview", folder, prefix);', '      var plan = await App.call("preview", folder, prefix);\n      if (sequence !== state.previewSequence || folder !== elFolder.value.trim() || prefix !== elPrefix.value) return;'),
    ('      applyPlan(plan);', '      applyPlan(plan);\n      state.planInput = { folder: folder, prefix: prefix };'),
    ('      setFieldError(elFieldPrefix, elErrPrefix, e.message);', '      if (sequence !== state.previewSequence) return;\n      state.plan = null; state.planInput = null; elExecute.disabled = true;\n      setFieldError(elFieldPrefix, elErrPrefix, e.message);'),
    ('    if (!state.plan || !state.plan.can_execute) {', '    if (!state.plan || !state.plan.can_execute || !state.planInput || state.planInput.folder !== folder || state.planInput.prefix !== prefix) {'),
]
for old, new in replacements:
    if ui.count(old) != 1:
        raise ValueError('Expected single UI repair point not found: ' + old)
    ui = ui.replace(old, new)
ui_path.write_text(ui, encoding='utf-8')
print('Patched current-input binding, stale preview responses and backend path validation in the preserved variant')
