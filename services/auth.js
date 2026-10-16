function createAuthHandlers(client, settings, scopes) {
    const refreshes = new Map();
    const save = session => new Promise((resolve, reject) => session.save(err => err ? reject(err) : resolve()));
    const getAuthorizationUrl = state => client.authorize(settings.APS_CLIENT_ID, 'code', settings.APS_CALLBACK_URL, scopes, { state });
    const sessionCredentials = session => async () => {
        if (!session?.refresh_token || !session.token || !Number.isFinite(session.expires_at)) {
            throw Object.assign(new Error('Your session expired. Sign in again.'), { status: 401 });
        }
        if (session.expires_at < Date.now() + 60000) {
            const key = session.refresh_token;
            if (!refreshes.has(key)) {
                const promise = client.refreshToken(key, settings.APS_CLIENT_ID, { clientSecret: settings.APS_CLIENT_SECRET, scopes });
                refreshes.set(key, promise);
                const timer = setTimeout(() => refreshes.delete(key), 120000); timer.unref();
            }
            let credentials;
            try { credentials = await refreshes.get(key); }
            catch (err) {
                const code = typeof err.httpStatusCode === 'function' ? err.httpStatusCode() : err.response?.status;
                if ([400, 401].includes(code)) throw Object.assign(new Error('Autodesk could not renew your session. Sign in again.'), { status: 401 });
                throw err;
            }
            Object.assign(session, { token: credentials.access_token, refresh_token: credentials.refresh_token, expires_at: Date.now() + credentials.expires_in * 1000 });
            await save(session);
        }
        return session.token;
    };
    const authCallbackMiddleware = async (req, res, next) => {
        if (typeof req.query.state !== 'string' || !req.session.oauthState || req.query.state !== req.session.oauthState) {
            throw Object.assign(new Error('Login verification failed. Start sign-in again from the app.'), { status: 400 });
        }
        delete req.session.oauthState;
        if (req.query.error) throw Object.assign(new Error('Autodesk sign-in was cancelled or access was declined. Start sign-in again when ready.'), { status: 400 });
        if (typeof req.query.code !== 'string' || !req.query.code) throw Object.assign(new Error('Autodesk did not return a login code. Sign in again.'), { status: 400 });
        const credentials = await client.getThreeLeggedToken(settings.APS_CLIENT_ID, req.query.code, settings.APS_CALLBACK_URL, { clientSecret: settings.APS_CLIENT_SECRET });
        await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
        Object.assign(req.session, { token: credentials.access_token, refresh_token: credentials.refresh_token, expires_at: Date.now() + credentials.expires_in * 1000 });
        await save(req.session);
        next();
    };
    const authRefreshMiddleware = async (req, res, next) => {
        try {
            const token = await sessionCredentials(req.session)();
            req.oAuthToken = { access_token: token, expires_in: Math.max(0, Math.round((req.session.expires_at - Date.now()) / 1000)) };
            next();
        } catch (err) {
            if (err.status === 401) return res.status(401).json({ error: err.message, code: 'SIGN_IN_REQUIRED' });
            next(err);
        }
    };
    return { getAuthorizationUrl, authCallbackMiddleware, authRefreshMiddleware, sessionCredentials };
}
module.exports = { createAuthHandlers };
