import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../../main/orchestration/orchestrator';
import { createProject, findProject } from '../../../main/project/project-service';
import { readPrdBackplane } from '../../../main/project/prd-store';
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment';
import type { AgentEvent } from '../../../shared/types';
import { resetSessionTreeForTests } from '../../../main/platform/sessions/session-tree';
vi.mock('../../../main/platform/llm/channel-manager', async (original) => ({ ...await original<typeof import('../../../main/platform/llm/channel-manager')>(), getChannelByIdRaw: () => ({ id: 'test-channel', name: 'Test', provider_type: 'anthropic', base_url: 'https://model.invalid', api_key: 'test-encrypted', enabled: true, models: [{ id: 'test-model', name: 'test-model', enabled: true }] }), decryptApiKey: () => 'test-key', getFirstEnabledChannel: () => undefined }));
describe('current short-brief clarification and confirmation through the public orchestrator', () => {
    let env: TemporaryPromaHome | undefined;
    beforeEach(() => resetSessionTreeForTests());
    afterEach(() => { env?.cleanup(); setAgentStreamPublisher(() => { }); setSDKQueryForTests(async function* () { throw Error('not configured'); }); });
    function setup() { env = useTemporaryPromaHome('bloma-brief-accept-'); const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' }), events: AgentEvent[] = []; setAgentStreamPublisher(event => events.push(event)); return { project, events, send: (content: string, index: number, option?: string) => runAgent({ request_id: 'r-' + index, session_id: 'guide-session', project_id: project.project_id, content, mode: 'quick', current_stage: findProject(project.project_id).current_stage, channel_id: 'test-channel', ...(option ? { metadata: { source: 'card_option' as const, selected_option_id: option } } : {}) }) }; }
    function respond(value: Record<string, unknown>) { setSDKQueryForTests(async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] } }; yield { type: 'result', stop_reason: 'end_turn' }; }); }
    const brief = { action: 'brief', name: '家庭账本', goal: '记录家庭收支', ui: 'required', delivery: 'desktop', requirements: [{ description: '记录家庭收支', expected: '显示已保存的收支' }], constraints: [], out_of_scope: [] };
    it('uses structured clarification, preserves conversation telemetry and does not start production', async () => {
        const f = setup();
        respond({ action: 'clarify', question: '主要给谁使用？', options: ['自己使用', '全家使用'] });
        await f.send('做一个家庭记账工具', 0);
        expect(f.events.filter(e => e.type === 'user_decision_required')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ kind: 'clarification', questions: [{ id: 'lean_answer_0', label: '自己使用' }, { id: 'lean_answer_1', label: '全家使用' }] }) })]);
        expect(findProject(f.project.project_id).desktop_phase).toBeUndefined();
        const history = readFileSync(join(env!.home, 'agent-sessions', 'guide-session.jsonl'), 'utf8');
        expect(history).toContain('做一个家庭记账工具');
        expect(history).toContain('主要给谁使用');
    });
    it('a complete first brief still waits for explicit scope confirmation rather than forcing extra questions or building', async () => {
        const f = setup();
        respond(brief);
        await f.send('做一个家庭账本，先给我核对需求', 0);
        expect(f.events.find(e => e.type === 'user_decision_required')?.payload.kind).toBe('lean_scope');
        expect(findProject(f.project.project_id).current_stage).toBe('blocked_for_user_decision');
        expect(readPrdBackplane(f.project.project_id).user_confirmed_at).toBeUndefined();
        expect(f.events.some(e => e.type === 'sketch_ready')).toBe(false);
    });
    it('keeps selected directions in later model context and pauses at the resulting brief', async () => {
        const f = setup();
        respond({ action: 'clarify', question: '主要给谁使用？', options: ['自己使用', '全家使用'] });
        await f.send('做一个家庭账本', 0);
        const wires: string[] = [];
        setSDKQueryForTests(async function* (_prompt, options) { wires.push(_prompt + JSON.stringify(options.messages)); yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ ...brief, constraints: ['自己使用'] }) }] } }; yield { type: 'result', stop_reason: 'end_turn' }; });
        await f.send('自己使用', 1, 'lean_answer_0');
        expect(wires.join('')).toContain('自己使用');
        expect(readPrdBackplane(f.project.project_id).constraints).toContain('自己使用');
        expect(readPrdBackplane(f.project.project_id).user_confirmed_at).toBeUndefined();
    });
});
