// Local mock only: no credentials, no calls to Autodesk, and no real project changes.
const express = require('express');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { fakeAPS } = require('./fake-aps.js');
const { Store } = require('../services/store.js');
const { Jobs } = require('../services/jobs.js');
const { createAdminRouter } = require('../routes/admin.js');
const aps = fakeAPS(), app = express();
// Optional failure modes for checking browser error handling; never loaded by server.js.
if (process.env.DEMO_FAILURE === 'projects') aps.getProjectsACC = async () => { throw Object.assign(new Error('Test fixture: project access denied.'), { status: 403 }); };
if (process.env.DEMO_FAILURE === 'members') aps.getProjectUsersACC = async () => { throw Object.assign(new Error('Test fixture: member access denied.'), { status: 403 }); };
if (process.env.DEMO_FAILURE === 'submit') app.post('/api/admin/jobs', (req, res) => res.status(503).json({ error: 'Test fixture: import service unavailable.' }));
const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-admin-demo-')));
const jobs = new Jobs(store, aps, { sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 400))) });
app.use(express.static(path.join(__dirname, '..', 'wwwroot')));
app.get('/api/auth/profile', (req, res) => res.json({ name: 'LOCAL DEMO' }));
app.get('/api/app', (req, res) => res.json({ mode: 'demo', version: '1.1.0', defaultRegion: 'US' }));
app.get('/api/auth/logout', (req, res) => res.redirect('/'));
app.get('/api/hubs', (req, res) => res.json([{ id: 'b.account-1', attributes: { name: 'Demo · Architecture Studio' } }]));
app.use(createAdminRouter(aps, store, jobs));
const port = process.env.DEMO_PORT || 8081;
app.listen(port, '127.0.0.1', () => console.log('Local mock ready at http://127.0.0.1:' + port + ' (no Autodesk writes)'));
