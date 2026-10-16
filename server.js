const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { statusCode, message } = require('./services/errors.js');

function createApp({ aps = require('./services/aps.js'), settings = require('./config.js'), store, jobs } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.get('/health', (req, res) => res.json({ status: 'ok', mode: 'live' }));
    app.get('/api/app', (req, res) => res.json({ mode: 'live', version: require('./package.json').version, defaultRegion: settings.APS_REGION || 'US' }));
    app.use(express.static(path.join(__dirname, 'wwwroot')));
    app.use(session({
        name: 'acc-admin-live.sid',
        secret: settings.SERVER_SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 24 * 60 * 60 * 1000 }
    }));
    app.use(require('./routes/auth.js').createAuthRouter(aps));
    app.use(require('./routes/hubs.js').createHubsRouter(aps));
    app.use(require('./routes/admin.js').createAdminRouter(aps, store, jobs));
    app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        const code = statusCode(err);
        const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 500;
        res.status(status).json({ error: message(err), ...(status === 401 ? { code: 'SIGN_IN_REQUIRED' } : {}) });
    });
    return app;
}
function start() {
    const settings = require('./config.js');
    const server = createApp({ settings }).listen(settings.PORT, settings.HOST, () => {
        const port = server.address().port;
        console.log('ACC Admin live server: http://localhost:' + port);
        const callback = new URL(settings.APS_CALLBACK_URL);
        if (Number(callback.port || (callback.protocol === 'https:' ? 443 : 80)) !== port) {
            console.warn('The callback URL uses a different port. Ensure APS_CALLBACK_URL matches this server or its reverse proxy.');
        }
    });
    server.on('error', err => {
        console.error(err.code === 'EADDRINUSE' ? 'The configured port is already in use. Stop the other server or update PORT and the registered callback URL.' : err.message);
        process.exitCode = 1;
    });
    return server;
}
if (require.main === module) {
    try { start(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { createApp, start };
