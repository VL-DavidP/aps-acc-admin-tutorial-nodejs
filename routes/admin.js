const express = require('express');
const crypto = require('node:crypto');
const { Store } = require('../services/store.js');
const { Jobs } = require('../services/jobs.js');
const csv = require('../wwwroot/csv.js');
const { statusCode, message } = require('../services/errors.js');
const identifier = value => typeof value === 'string' && /^(b\.)?[a-zA-Z0-9-]{1,100}$/.test(value);
function createAdminRouter(aps, store = new Store(), jobs = new Jobs(store, aps)) {
    const router = express.Router();
    router.use('/api/admin', aps.authRefreshMiddleware, express.json({ limit: '2mb' }));
    router.use('/api/admin', async (req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method)) {
            if (req.get('X-Admin-Request') !== '1' || (req.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(req.get('Sec-Fetch-Site')))) return res.status(403).json({ error: 'Use this application to submit changes.' });
        }
        if (req.query.region && !['US', 'EMEA', 'AUS'].includes(req.query.region)) return res.status(400).json({ error: 'Invalid region.' });
        req.region = req.query.region || 'US';
        const profile = await aps.getUserProfile(req.oAuthToken);
        if (!profile.email) return res.status(403).json({ error: 'Could not identify the signed-in Autodesk user.' });
        req.actor = profile;
        req.owner = crypto.createHash('sha256').update(profile.sub || profile.userId || profile.email.toLowerCase()).digest('hex');
        next();
    });
    const requireAccount = req => {
        if (!identifier(req.query.accountId)) throw Object.assign(new Error('A valid accountId is required.'), { status: 400 });
        return req.query.accountId.replace(/^b\./, '');
    };
    const requireProject = req => {
        if (!identifier(req.query.projectId)) throw Object.assign(new Error('A valid projectId is required.'), { status: 400 });
        return req.query.projectId.replace(/^b\./, '');
    };
    const ownJob = req => {
        const job = store.state.jobs.find(j => j.id === req.params.id && j.owner === req.owner);
        if (!job) throw Object.assign(new Error('Batch not found.'), { status: 404 });
        return job;
    };
    const publicJob = job => {
        const { owner, executing, inputHash, ...safe } = job;
        return safe;
    };
    router.get('/api/admin/projects', async (req, res) => res.json(await aps.getProjectsACC(requireAccount(req), req.oAuthToken.access_token, req.region)));
    router.get('/api/admin/project', async (req, res) => res.json(await aps.getProjectACC(requireProject(req), req.oAuthToken.access_token, req.region)));
    router.get('/api/admin/project/users', async (req, res) => res.json(await aps.getProjectUsersACC(requireProject(req), req.oAuthToken.access_token, req.region)));
    router.post('/api/admin/jobs', (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Provide a JSON import request.' });
        if (!identifier(body.accountId) || (body.projectId && !identifier(body.projectId))) return res.status(400).json({ error: 'Invalid account/project ID.' });
        const job = jobs.create(req.owner, { ...body, region: req.region }, req.actor);
        if (job.status === 'queued') jobs.enqueue(job, aps.sessionCredentials(req.session));
        res.status(202).json(publicJob(job));
    });
    router.get('/api/admin/jobs', (req, res) => res.json(store.state.jobs.filter(j => j.owner === req.owner).map(publicJob).reverse()));
    router.get('/api/admin/jobs/:id', (req, res) => res.json(publicJob(ownJob(req))));
    router.post('/api/admin/jobs/:id/retry', (req, res) => res.json(publicJob(jobs.retry(ownJob(req), aps.sessionCredentials(req.session)))));
    router.get('/api/admin/presets', (req, res) => res.json(store.state.presets.filter(p => p.owner === req.owner).map(({ owner, ...p }) => p)));
    router.post('/api/admin/presets', (req, res) => {
        const { name, defaults } = req.body;
        if (typeof name !== 'string' || !name.trim() || name.length > 80 || !defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return res.status(400).json({ error: 'Provide a preset name and defaults.' });
        const unknown = Object.keys(defaults).filter(k => !csv.projectFields.includes(k) || k === 'name');
        if (unknown.length || Object.values(defaults).some(v => typeof v !== 'string')) return res.status(400).json({ error: 'Preset defaults must be supported text fields, excluding project name.' });
        const check = csv.validate('projects', [{ name: 'Preset validation', type: 'Commercial', ...defaults }])[0];
        if (check.errors.length) return res.status(400).json({ error: check.errors.join(' ') });
        const preset = { id: crypto.randomUUID(), owner: req.owner, name: name.trim(), defaults };
        store.state.presets.push(preset); store.save();
        const { owner, ...safe } = preset; res.status(201).json(safe);
    });
    router.delete('/api/admin/presets/:id', (req, res) => {
        const index = store.state.presets.findIndex(p => p.id === req.params.id && p.owner === req.owner);
        if (index < 0) return res.status(404).json({ error: 'Preset not found.' });
        store.state.presets.splice(index, 1); store.save(); res.status(204).end();
    });
    router.patch('/api/admin/project/users/:userId', async (req, res) => {
        if (!identifier(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID.' });
        const { email, companyId, roleIds, products } = req.body;
        const record = { email };
        if (companyId) record.companyId = companyId;
        if (Array.isArray(roleIds)) record.roleIds = roleIds.join('|');
        if (Array.isArray(products)) for (const p of products) record['products.' + p.key] = p.access;
        const row = csv.validate('memberUpdates', [record])[0];
        if (row.errors.length) return res.status(400).json({ error: row.errors.join(' ') });
        const projectId = requireProject(req);
        const response = await aps.updateProjectUserACC(projectId, req.params.userId, row.payload, req.oAuthToken.access_token, req.region);
        store.event(req.owner, 'Updated member access', { projectId, userId: req.params.userId, email });
        res.json(response);
    });
    router.delete('/api/admin/project/users/:userId', async (req, res) => {
        if (!identifier(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID.' });
        const projectId = requireProject(req);
        await aps.removeProjectUserACC(projectId, req.params.userId, req.oAuthToken.access_token, req.region);
        store.event(req.owner, 'Removed project member', { projectId, userId: req.params.userId });
        res.status(204).end();
    });
    router.get('/api/admin/events', (req, res) => res.json(store.state.events.filter(e => e.owner === req.owner).map(({ owner, ...event }) => event).reverse()));
    router.get('/api/admin/report', async (req, res) => {
        const credentials = aps.sessionCredentials(req.session);
        const projects = await aps.getProjectsACC(requireAccount(req), req.oAuthToken.access_token, req.region);
        const rows = [], failures = [];
        for (const project of projects) {
            try {
                const users = await aps.getProjectUsersACC(project.id, await credentials(), req.region);
                for (const user of users) rows.push({ projectId: project.id, projectName: project.name, email: user.email, name: user.name, company: user.companyName, status: user.status, products: user.products, roles: user.roles });
            } catch (err) { failures.push({ projectId: project.id, name: project.name, error: err.message }); }
        }
        res.json({ rows, failures, projectCount: projects.length, generatedAt: new Date().toISOString() });
    });
    router.use('/api/admin', (err, req, res, next) => {
        const status = statusCode(err) || 500;
        res.status(status >= 400 && status < 600 ? status : 500).json({ error: message(err) });
    });
    return router;
}
module.exports = { createAdminRouter };
