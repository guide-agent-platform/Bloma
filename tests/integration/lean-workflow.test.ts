import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ dialog: {} }));
import { registerProjectsIpc } from '../../main/ipc/projects';
import { IPC_CHANNELS, type AgentEvent, type Project, type AgentSendMessageInput } from '../../shared/types';
import { handleGuideMessage } from '../../main/guide/stages/guide-pipeline';
import { findProject } from '../../main/project/project-service';
import { activeSoftwareRelease } from '../../main/software/release-store';
import { readQualityLedger } from '../../main/software/quality-review';
import { runCoreVerification } from '../../main/desktop/core-verification';
import { leanBudget } from '../../main/desktop/lean-budget';
import { attachModelLimits } from '../../main/platform/llm/model-context';
import { anthropicMessagesQueryViaProviders } from '../../main/platform/upstream/providers/loop-query';
import { startPlatformFlowModel } from '../fixtures/platform-flow-model.mjs';
let home: string, previous: string | undefined, model: Awaited<ReturnType<typeof startPlatformFlowModel>> | undefined;
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-workflow-native-')); process.env.PROMA_HOME = home; });
afterEach(async () => { await model?.close(); model = undefined; if (previous === undefined)
    delete process.env.PROMA_HOME;
else
    process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
it.each(['cli', 'gui'])('public creation → confirmed %s → real Pi/C/V → native host delivery; broken behavior still fails', async (kind) => {
    const handlers = new Map<string, (e: unknown, p: unknown) => Promise<{
        ok: boolean;
        data: Project;
    }>>();
    registerProjectsIpc({ handle: (name: string, handler: never) => handlers.set(name, handler) } as never, {} as never);
    const created = await handlers.get(IPC_CHANNELS.PROJECT_CREATE)!({}, { request_id: 'create', mode: 'quick' });
    expect(created.ok).toBe(true);
    const project = created.data;
    expect(project.workflow_version).toBe('software-v1');
    model = await startPlatformFlowModel(createRequire(import.meta.url)('electron'));
    model.setScenario(kind);
    const env = { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_AUTH_TOKEN: 'LOCAL_FIXTURE_ONLY', ANTHROPIC_MODEL: 'local-platform-model', ANTHROPIC_PROVIDER_TYPE: 'anthropic-compatible', PATH: process.env.PATH ?? '' };
    attachModelLimits(env, { context_window: 1000000 });
    const events: AgentEvent[] = [], input: AgentSendMessageInput = { project_id: project.project_id, session_id: 's', request_id: 'goal', mode: 'quick', current_stage: 'clarifying', content: kind === 'gui' ? '做一个本地记事本，保存后关闭重开记录仍保留' : '做一个命令行工具，输出42' }, options = { query: anthropicMessagesQueryViaProviders, env, signal: AbortSignal.timeout(180000), sessionId: 's', history: [], maxTokens: 8192, persistAssistant: vi.fn() }, publish = (event: AgentEvent) => events.push(event);
    await handleGuideMessage(input, publish, options);
    const scope = (events.find(e => e.payload.kind === 'lean_scope')!.payload.questions as Array<{
        id: string;
    }>)[0].id;
    await handleGuideMessage({ ...input, content: '按这份做', metadata: { source: 'card_option', selected_option_id: scope } }, publish, options);
    if (kind === 'gui')
        await handleGuideMessage({ ...input, content: '确认草图', metadata: { source: 'card_option', selected_option_id: 'ux_confirm_go' } }, publish, options);
    expect(findProject(project.project_id), JSON.stringify(events.slice(-4))).toMatchObject({ status: 'completed', current_stage: 'completed', desktop_phase: 'delivered' });
    const release = await activeSoftwareRelease(project.project_id);
    expect(release).toBeDefined();
    const positive = JSON.parse(readFileSync(join(release!.root, '00_VERIFY/core-verification.json'), 'utf8'));
    expect(positive.status).toBe('passed');
    const reviews = readQualityLedger(project.project_id).reviews;
    expect(reviews.some(r => r.kind === 'code' && r.status === 'complete')).toBe(true);
    if (kind === 'gui') {
        expect(reviews.some(r => r.kind === 'visual' && r.status === 'complete')).toBe(true);
        expect(model.observations.some(r => r.has_image)).toBe(true);
    }
    expect(leanBudget(project.project_id, 'desktop-implement').snapshot().requests).toBe(model.observations.filter(r => r.n).length);
    const before = model.observations.length;
    writeFileSync(join(project.root_path, kind === 'gui' ? 'main.cjs' : 'app.cjs'), kind === 'gui' ? 'throw Error("deliberately broken")' : 'console.log(999)');
    const negative = await runCoreVerification({ projectId: project.project_id, signal: AbortSignal.timeout(60000) });
    expect(negative.status).not.toBe('passed');
    expect(model.observations.length).toBe(before);
    writeFileSync(resolve('run-artifacts/lean-current-' + kind + '.json'), JSON.stringify({ controlled_model: true, paid_requests: 0, requests: before, positive: positive.status, negative: negative.status, reviews: reviews.map(r => ({ kind: r.kind, status: r.status })) }, null, 2));
}, 240000);
