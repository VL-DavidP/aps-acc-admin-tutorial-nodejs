const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const csv = require('../wwwroot/csv.js');
const { Store } = require('../services/store.js');
const { Jobs } = require('../services/jobs.js');
const { fakeAPS } = require('./fake-aps.js');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-admin-test-'));
    t.after(() => {
        const resolved = path.resolve(dir);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('acc-admin-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const store = new Store(dir), aps = fakeAPS(), jobs = new Jobs(store, aps, { sleep: async () => {}, polls: 2 });
    const create = (kind, records, requestId = 'request-1234567890') => jobs.create('owner', { requestId, kind, records, accountId: 'b.account-1', projectId: 'b.project-1', region: 'AUS' }, { email: 'admin@example.com' });
    return { dir, store, aps, jobs, create };
}
test('CSV handles BOM, all line endings, embedded commas, quotes, newlines, blank rows', () => {
    const result = csv.parse('\uFEFFname,type\r\n"Tower, East","Commercial"\r\n"Line\nTwo ""A""",Education\n\n');
    assert.deepEqual(result.records, [{ name: 'Tower, East', type: 'Commercial' }, { name: 'Line\nTwo "A"', type: 'Education' }]);
    assert.deepEqual(csv.parse('name,type\rA,B\r').records, [{ name: 'A', type: 'B' }]);
});
test('CSV rejects malformed input instead of silently shifting fields', () => {
    for (const text of ['name,name\nA,B', 'name,type\nA,B,C', 'name,type\n"A,B', 'name,type\n"A"x,B']) assert.throws(() => csv.parse(text));
});
test('validation catches duplicates, unknown columns, dates, emails, access and supports presets', () => {
    const rows = csv.validate('projects', [{ name: 'A', startDate: '2026-02-30' }, { name: ' a ', mystery: 'x' }], { type: 'Commercial', timezone: 'Australia/Sydney' });
    assert.ok(rows[0].errors.some(s => s.includes('date')));
    assert.ok(rows[1].errors.some(s => s.includes('Duplicate')));
    assert.ok(rows[1].errors.some(s => s.includes('Unknown')));
    assert.equal(rows[0].payload.type, 'Commercial');
    assert.ok(csv.validate('members', [{ email: 'bad', 'products.docs': 'god' }])[0].errors.length >= 2);
    const member = csv.validate('members', [{ email: 'a@b.com', roleIds: 'a | b', 'products.docs': 'member' }])[0];
    assert.deepEqual(member.payload.roleIds, ['a', 'b']);
    assert.deepEqual(member.payload.products, [{ key: 'docs', access: 'member' }]);
});
test('exports preserve nested details and neutralize spreadsheet formulas', () => {
    const text = csv.stringify([{ name: '=1+1', details: [{ key: 'docs' }] }]);
    assert.equal(csv.parse(text).records[0].name, "'=1+1");
    assert.deepEqual(JSON.parse(csv.parse(text).records[0].details), [{ key: 'docs' }]);
});
test('role-only membership updates leave product access unspecified', () => {
    const row = csv.validate('memberUpdates', [{ email: 'person@example.com', roleIds: 'role-1' }])[0];
    assert.deepEqual(row.errors, []);
    assert.deepEqual(row.payload.roleIds, ['role-1']);
    assert.equal(Object.hasOwn(row.payload, 'products'), false);
});
test('a request ID cannot be reused for different import contents', t => {
    const { create } = fixture(t);
    const job = create('projects', [{ name: 'First', type: 'Commercial' }]);
    assert.equal(create('projects', [{ name: 'First', type: 'Commercial' }]).id, job.id);
    assert.throws(() => create('projects', [{ name: 'Changed', type: 'Commercial' }]), err => err.status === 409);
});
test('real SDK error wrappers expose useful status and error messages', () => {
    const { ConstructionAccountAdminApiError } = require('@aps_sdk/construction-account-admin');
    const { statusCode, message } = require('../services/errors.js');
    const err = new ConstructionAccountAdminApiError('SDK error', { response: { status: 429, data: { message: 'Wait before retrying' } } });
    assert.equal(statusCode(err), 429);
    assert.equal(message(err), 'Wait before retrying');
});
test('the real Autodesk write service does not replay failed create requests', async () => {
    const axios = require('axios'), { AxiosError } = axios;
    const adapter = axios.defaults.adapter;
    const env = { APS_CLIENT_ID: 'test', APS_CLIENT_SECRET: 'test', APS_CALLBACK_URL: 'http://localhost:8080/api/auth/callback', SERVER_SESSION_SECRET: 'test' };
    const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    let calls = 0;
    axios.defaults.adapter = async config => {
        calls++;
        throw new AxiosError('Unavailable', 'ERR_BAD_RESPONSE', config, {}, { status: 503, data: { message: 'Unavailable' }, headers: {}, config });
    };
    try {
        const aps = require('../services/aps.js');
        await assert.rejects(aps.createProjectACC('account-1', { name: 'No replay', type: 'Commercial' }, 'fake-token'), /Unavailable/);
        assert.equal(calls, 1);
        await assert.rejects(aps.createProjectACC('account-1', { name: 'Next request', type: 'Commercial' }, 'fake-token'), /Unavailable/);
        assert.equal(calls, 2);
    } finally {
        axios.defaults.adapter = adapter;
        for (const [k, value] of Object.entries(previous)) { if (value == null) delete process.env[k]; else process.env[k] = value; }
    }
});
test('bulk jobs create more than five projects and preserve idempotent submission', async t => {
    const { jobs, aps, create } = fixture(t);
    const records = Array.from({ length: 8 }, (_, i) => ({ name: 'Project ' + i, type: 'Commercial' }));
    const job = create('projects', records);
    assert.equal(create('projects', records).id, job.id);
    await jobs.run(job, async () => 'token');
    assert.equal(aps.creates, 8);
    assert.ok(job.rows.every(r => r.status === 'succeeded'));
    assert.equal(job.accountId, 'account-1');
});
test('retrying administrator setup resumes the existing project', async t => {
    const { jobs, aps, create, store } = fixture(t);
    const original = aps.addProjectAdminACC;
    aps.addProjectAdminACC = async () => { throw Object.assign(new Error('Rate limited'), { status: 429 }); };
    const job = create('projects', [{ name: 'Retry me', type: 'Commercial' }]);
    await jobs.run(job, async () => 'token');
    assert.equal(job.rows[0].status, 'failed');
    assert.equal(job.rows[0].retryable, true);
    assert.ok(job.rows[0].projectId);
    aps.addProjectAdminACC = original;
    // Simulate a new server process; saved project ID must survive.
    const restored = new Store(store.directory), resumed = new Jobs(restored, aps, { sleep: async () => {} });
    const saved = restored.state.jobs[0];
    saved.rows[0].status = 'queued';
    await resumed.run(saved, async () => 'token');
    assert.equal(saved.rows[0].status, 'succeeded');
    assert.equal(aps.creates, 1);
});
test('unknown create outcomes are never blindly retried', async t => {
    const { jobs, aps, create } = fixture(t);
    aps.createProjectACC = async () => { throw new Error('Connection lost'); };
    const job = create('projects', [{ name: 'Uncertain', type: 'Commercial' }]);
    await jobs.run(job, async () => 'token');
    assert.equal(job.rows[0].status, 'uncertain');
    assert.equal(job.rows[0].retryable, false);
    assert.throws(() => jobs.retry(job, async () => 'token'), /No safely retryable/);
});
test('HTTP timeout responses during creation remain uncertain', async t => {
    const { jobs, aps, create } = fixture(t);
    aps.createProjectACC = async () => { throw Object.assign(new Error('Gateway timeout'), { status: 408 }); };
    const job = create('projects', [{ name: 'Timeout', type: 'Commercial' }]);
    await jobs.run(job, async () => 'token');
    assert.equal(job.rows[0].status, 'uncertain');
});
test('existing project names are blocked and member updates use existing IDs', async t => {
    const { jobs, aps, create } = fixture(t);
    const existing = create('projects', [{ name: 'Harbour Exchange', type: 'Commercial' }]);
    await jobs.run(existing, async () => 'token');
    assert.equal(existing.rows[0].status, 'failed'); assert.equal(aps.creates, 0);
    const update = create('memberUpdates', [{ email: 'alex@example.com', 'products.docs': 'administrator' }], 'another-request-123');
    await jobs.run(update, async () => 'token');
    assert.equal(update.rows[0].status, 'succeeded');
    assert.equal(aps.users['project-1'][0].products[0].access, 'administrator');
});
test('restart recovery marks in-flight writes uncertain and queued rows retryable', t => {
    const { store, aps, create } = fixture(t);
    const job = create('projects', [{ name: 'A', type: 'Commercial' }, { name: 'B', type: 'Commercial' }]);
    job.status = 'running'; job.executing = true; job.rows[0].status = 'creating'; store.save();
    const restored = new Store(store.directory); new Jobs(restored, aps);
    assert.equal(restored.state.jobs[0].status, 'interrupted');
    assert.equal(restored.state.jobs[0].rows[0].status, 'uncertain');
    assert.equal(restored.state.jobs[0].rows[1].retryable, true);
    assert.equal(restored.state.jobs[0].executing, undefined);
});
test('rate-limited creation retries without repeating successful rows', async t => {
    const { jobs, aps, create } = fixture(t);
    const original = aps.createProjectACC;
    let limited = true;
    aps.createProjectACC = async (...args) => {
        if (args[1].name === 'B' && limited) throw Object.assign(new Error('Rate limited'), { status: 429 });
        return original(...args);
    };
    const job = create('projects', [{ name: 'A', type: 'Commercial' }, { name: 'B', type: 'Commercial' }]);
    await jobs.run(job, async () => 'token');
    assert.equal(job.rows[0].status, 'succeeded');
    assert.equal(job.rows[1].retryable, true);
    limited = false; jobs.retry(job, async () => 'token');
    while (jobs.busy) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(job.rows.every(r => r.status === 'succeeded'));
    assert.equal(aps.creates, 2);
    assert.equal(job.rows[0].attempts, 1);
    assert.equal(job.rows[1].attempts, 2);
});
test('project setup retries update already-assigned administrators', async t => {
    const { jobs, aps, create } = fixture(t);
    const job = create('projects', [{ name: 'Setup', type: 'Commercial', initialAdminEmails: 'other@example.com' }]);
    let fail = true;
    const assign = aps.addProjectAdminACC;
    aps.addProjectAdminACC = async (...args) => {
        if (args[1] === 'other@example.com' && fail) throw Object.assign(new Error('Forbidden'), { status: 403 });
        return assign(...args);
    };
    await jobs.run(job, async () => 'token');
    assert.equal(job.rows[0].status, 'failed');
    fail = false; jobs.retry(job, async () => 'token');
    while (jobs.busy) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(job.rows[0].status, 'succeeded');
    assert.equal(aps.creates, 1);
    assert.equal(aps.users[job.rows[0].projectId].length, 2);
});
test('HTTP routes isolate history and presets, reject cross-site writes, and manage members', async t => {
    const express = require('express');
    const { createAdminRouter } = require('../routes/admin.js');
    const { store, aps, jobs } = fixture(t), app = express();
    app.use(createAdminRouter(aps, store, jobs));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const send = (url, body, method = 'POST', user = 'alice', headers = {}) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', 'X-Test-User': user, ...headers }, body: body == null ? undefined : JSON.stringify(body) });
    const preset = await send('/api/admin/presets', { name: 'AU', defaults: { country: 'Australia' } });
    assert.equal(preset.status, 201);
    assert.equal((await (await send('/api/admin/presets', null, 'GET', 'bob')).json()).length, 0);
    assert.equal((await send('/api/admin/presets', { name: 'x', defaults: {} }, 'POST', 'alice', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const getUsers = aps.getProjectUsersACC;
    aps.getProjectUsersACC = async id => { if (id === 'project-2') throw new Error('No access'); return getUsers(id); };
    const report = await (await send('/api/admin/report?accountId=account-1', null, 'GET')).json();
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].projectId, 'project-2');
    assert.ok(report.rows.some(r => r.email === 'alex@example.com'));
    aps.getProjectUsersACC = getUsers;
    assert.equal((await send('/api/admin/project/users/user-1?projectId=b.project-1&region=AUS', { email: 'alex@example.com', products: [{ key: 'docs', access: 'administrator' }] }, 'PATCH')).status, 200);
    assert.equal(aps.users['project-1'][0].products[0].access, 'administrator');
    assert.equal((await send('/api/admin/project/users/user-1?projectId=project-1', null, 'DELETE')).status, 204);
    assert.equal(aps.users['project-1'].length, 0);
    const jobResponse = await send('/api/admin/jobs', { requestId: 'http-request-123456', kind: 'projects', accountId: 'account-1', records: [{ name: 'HTTP Project', type: 'Commercial' }] });
    assert.equal(jobResponse.status, 202);
    const job = await jobResponse.json();
    assert.equal((await send('/api/admin/jobs/' + job.id, null, 'GET', 'bob')).status, 404);
    const list = await (await send('/api/admin/jobs', null, 'GET', 'alice')).json();
    assert.equal(list.length, 1); assert.equal('owner' in list[0], false);
    // Let the in-memory worker finish before fixture cleanup.
    while (jobs.busy) await new Promise(resolve => setTimeout(resolve, 5));
});
