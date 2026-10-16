const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAuthHandlers } = require('../services/auth.js');
const { collectPages } = require('../services/pagination.js');

const settings = { APS_CLIENT_ID: 'local-test', APS_CLIENT_SECRET: 'local-test', APS_CALLBACK_URL: 'http://localhost:8080/api/auth/callback', SERVER_SESSION_SECRET: 'local-test-secret', APS_REGION: 'AUS' };
const scopes = ['data:read', 'data:write', 'account:read', 'account:write'];
function session(values = {}) { return { ...values, save(callback) { callback(); } }; }
function privateDirectory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-admin-live-test-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dir).startsWith('acc-admin-live-test-'));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}
test('token refresh shares one request across concurrent sessions and saves both', async () => {
    let calls = 0, saves = 0;
    const client = { async refreshToken(token, id, options) {
        calls++; assert.equal(token, 'old-refresh'); assert.deepEqual(options.scopes, scopes);
        await new Promise(resolve => setTimeout(resolve, 5));
        return { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 };
    } };
    const auth = createAuthHandlers(client, settings, scopes);
    const a = session({ token: 'old-access', refresh_token: 'old-refresh', expires_at: 0 });
    const b = session({ ...a });
    a.save = b.save = callback => { saves++; callback(); };
    assert.deepEqual(await Promise.all([auth.sessionCredentials(a)(), auth.sessionCredentials(b)()]), ['new-access', 'new-access']);
    assert.equal(calls, 1); assert.equal(saves, 2);
    assert.equal(a.refresh_token, 'new-refresh'); assert.ok(a.expires_at > Date.now());
});
test('expired or invalid Autodesk sessions produce a sign-in response', async () => {
    const auth = createAuthHandlers({ refreshToken: async () => { throw { httpStatusCode: () => 400 }; } }, settings, scopes);
    await assert.rejects(auth.sessionCredentials(session())(), err => err.status === 401);
    await assert.rejects(auth.sessionCredentials(session({ token: 'old', refresh_token: 'invalid', expires_at: 0 }))(), err => err.status === 401);
    let status, body;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; } };
    await auth.authRefreshMiddleware({ session: session() }, res, () => assert.fail('Must not continue'));
    assert.equal(status, 401); assert.equal(body.code, 'SIGN_IN_REQUIRED');
});
test('OAuth rejects invalid state and cancellation before exchanging a token', async () => {
    let exchanges = 0;
    const auth = createAuthHandlers({ getThreeLeggedToken: async () => { exchanges++; } }, settings, scopes);
    await assert.rejects(auth.authCallbackMiddleware({ query: { code: 'code', state: 'wrong' }, session: session({ oauthState: 'right' }) }, {}, () => {}), /verification failed/);
    await assert.rejects(auth.authCallbackMiddleware({ query: { error: 'access_denied', state: 'right' }, session: session({ oauthState: 'right' }) }, {}, () => {}), /cancelled/);
    assert.equal(exchanges, 0);
});
test('OAuth saves tokens after regenerating the authenticated session', async () => {
    const events = [];
    const auth = createAuthHandlers({ getThreeLeggedToken: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }) }, settings, scopes);
    const req = { query: { code: 'code', state: 'state' }, session: { oauthState: 'state', regenerate(callback) {
        events.push('regenerate');
        req.session = { save(callback) { events.push('save'); callback(); } }; callback();
    } } };
    await auth.authCallbackMiddleware(req, {}, () => events.push('next'));
    assert.deepEqual(events, ['regenerate', 'save', 'next']);
    assert.equal(req.session.token, 'access'); assert.equal(req.session.oauthState, undefined);
});
test('pagination returns every page and rejects incomplete or stalled responses', async () => {
    const offsets = [];
    const rows = await collectPages(async offset => { offsets.push(offset); return { results: offset === 0 ? ['a', 'b'] : ['c'], pagination: { limit: 2, totalResults: 3 } }; });
    assert.deepEqual(offsets, [0, 2]); assert.deepEqual(rows, ['a', 'b', 'c']);
    await assert.rejects(collectPages(async () => ({ results: [], pagination: { limit: 20, totalResults: 50 } })), err => err.status === 502);
    await assert.rejects(collectPages(async () => ({ results: [], pagination: { limit: 0, totalResults: 50 } })), err => err.status === 502);
});
test('live app serves real UI, protects routes, completes OAuth, and preserves server session', async t => {
    const { createApp } = require('../server.js');
    const { Store } = require('../services/store.js');
    const { fakeAPS } = require('./fake-aps.js');
    const store = new Store(privateDirectory(t)), aps = fakeAPS();
    let exchanges = 0;
    Object.assign(aps, createAuthHandlers({
        authorize(id, type, callback, scopes, { state }) { return 'https://signin.example/authorize?state=' + state; },
        getThreeLeggedToken: async () => { exchanges++; return { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }; }
    }, settings, scopes));
    aps.getUserProfile = async () => ({ sub: 'user-1', email: 'admin@example.com', name: 'Administrator' });
    let failHubs = false;
    aps.getHubs = async () => {
        if (failHubs) throw Object.assign(new Error('Autodesk temporarily unavailable'), { status: 503 });
        return [{ id: 'b.account-1', attributes: { name: 'Test account' } }];
    };
    const app = createApp({ settings, aps, store });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/health')).status, 200);
    const metadata = await (await fetch(base + '/api/app')).json();
    assert.equal(metadata.mode, 'live'); assert.equal(metadata.defaultRegion, 'AUS');
    for (const endpoint of ['/api/auth/profile', '/api/hubs', '/api/admin/projects', '/api/admin/jobs', '/api/admin/presets', '/api/admin/report']) {
        assert.equal((await fetch(base + endpoint)).status, 401, endpoint);
    }
    const login = await fetch(base + '/api/auth/login', { redirect: 'manual' });
    assert.equal(login.status, 302);
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    let cookie = login.headers.get('set-cookie').split(';')[0];
    const callback = await fetch(base + '/api/auth/callback?code=fake&state=' + state, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(callback.status, 302); assert.equal(callback.headers.get('location'), '/'); assert.equal(exchanges, 1);
    cookie = callback.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
    const profile = await fetch(base + '/api/auth/profile', { headers });
    assert.equal(profile.status, 200); assert.equal(profile.headers.get('cache-control'), 'no-store');
    const projects = await (await fetch(base + '/api/admin/projects?accountId=account-1&region=AUS', { headers })).json();
    assert.equal(projects.length, 3);
    const preset = await fetch(base + '/api/admin/presets', { headers, method: 'POST', body: JSON.stringify({ name: 'Saved', defaults: { country: 'Australia' } }) });
    assert.equal(preset.status, 201);
    assert.equal(new Store(store.directory).state.presets.length, 1);
    failHubs = true;
    const failed = await fetch(base + '/api/hubs', { headers });
    assert.equal(failed.status, 503); assert.equal((await failed.json()).error, 'Autodesk temporarily unavailable');
    const logout = await fetch(base + '/api/auth/logout', { headers, redirect: 'manual' }); assert.equal(logout.status, 302);
    assert.equal((await fetch(base + '/api/auth/profile', { headers })).status, 401);
});
