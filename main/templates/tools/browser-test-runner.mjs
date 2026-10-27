import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect } from 'playwright/test';
import { connectApp } from './browser-context.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindScreenshotEvidence } from './browser-evidence.mjs';
await test('Bloma native application suite', async () => {
    const { browser, page, context } = await connectApp();
    const evidenceDir = bindScreenshotEvidence(page, context);
    const counts = { interactions: 0, assertions: 0, cases: [] }, cache = new WeakMap(), current = new AsyncLocalStorage();
    const observed = key => { counts[key]++; const active = current.getStore(); if (active)
        active[key]++; };
    const actions = new Set(['fill', 'click', 'dblclick', 'selectOption', 'check', 'uncheck', 'press', 'setInputFiles', 'dragTo', 'type', 'tap', 'hover', 'down', 'up', 'move', 'wheel']);
    const object = value => {
        if(Array.isArray(value))return value.map(object)
        if (!value || typeof value !== 'object' || !('locator' in value || 'click' in value || 'pages' in value || 'press' in value || 'tap' in value))
            return value;
        if (cache.has(value))
            return cache.get(value);
        const proxy = new Proxy(value, { get(target, key) {
                const member = Reflect.get(target, key, target);
                if (typeof member !== 'function')
                    return object(member);
                return (...args) => {
                    const result = member.apply(target, args);
                    if (actions.has(String(key)))
                        return Promise.resolve(result).then(actual => { observed('interactions'); return actual; });
                    return result?.then ? result.then(object) : object(result);
                };
            } });
        cache.set(value, proxy);
        return proxy;
    };
    const matcher = value => new Proxy(value, { get(target, key) {
            const member = Reflect.get(target, key, target);
            if (typeof member === 'function')
                return (...args) => Promise.resolve(member.apply(target, args)).then(result => { observed('assertions'); return result; });
            return member && typeof member === 'object' ? matcher(member) : member;
        } });
    const checkedAssertion = api => new Proxy(api, { apply(target, self, args) { const result = Reflect.apply(target, self, args); observed('assertions'); return result; },
        get(target, key) { const member = Reflect.get(target, key); return typeof member === 'function' ? (...args) => { const result = member.apply(target, args); if (result?.then)
            return result.then(v => { observed('assertions'); return v; }); observed('assertions'); return result; } : member; } });
    const checkedAssert = checkedAssertion(assert);
    const runCase = (method, args) => {
        const callback = args.at(-1);
        if (typeof callback !== 'function')
            return method(...args);
        return method(...args.slice(0, -1), async (t) => {
            const record = { name: String(args[0]), interactions: 0, assertions: 0 };
            counts.cases.push(record);
            return current.run(record, async () => { await callback(new Proxy(t, { get(target, key) { if (key === 'assert')
                    return checkedAssertion(target.assert); if (key === 'test')
                    return (...nested) => runCase(target.test.bind(target), nested); const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } })); if (/\bF-\d+\b/.test(record.name) && !record.assertions)
                throw Error('GUI_NATIVE_ASSERTION_REQUIRED: 每项业务测试需实际断言'); });
        });
    };
    const checkedTest = new Proxy(test, { apply(target, self, args) { return runCase(target, args); }, get(target, key) { const member = Reflect.get(target, key); return ['skip', 'todo', 'only'].includes(String(key)) ? (...args) => runCase(member, args) : member; } });
    try {
        const script = await import(pathToFileURL(process.env.BLOMA_NATIVE_TEST_FILE).href);
        if (typeof script.default !== 'function')
            throw Error('GUI_NATIVE_DEFAULT_FUNCTION_REQUIRED');
        const checkedExpect = new Proxy(expect, { apply(target, self, args) { return matcher(Reflect.apply(target, self, args)); }, get(target, key) { const member = Reflect.get(target, key); return key === 'poll' ? (...args) => matcher(member(...args)) : member; } });
        await script.default({ test: checkedTest, page: object(page), context: object(context), expect: checkedExpect, assert: checkedAssert,
            dataDir: process.env.APP_DATA_DIR, evidenceDir, phase: process.env.BLOMA_NATIVE_TEST_PHASE });
    }
    finally {
        writeFileSync(process.env.BLOMA_NATIVE_TEST_TRACE, JSON.stringify(counts));
        // CDP Browser.close disconnects this client; it does not own the app process.
        await browser.close();
    }
});
