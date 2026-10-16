const crypto = require('node:crypto');
const { validate, keyOf } = require('../wwwroot/csv.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const { statusCode, message } = require('./errors.js');
const invalid = text => Object.assign(new Error(text), { status: 400 });
class Jobs {
    constructor(store, aps, options = {}) {
        this.store = store; this.aps = aps;
        this.sleep = options.sleep || sleep;
        this.polls = options.polls || 60;
        this.busy = false; this.queue = []; this.active = new Set();
        for (const job of store.state.jobs) {
            delete job.executing;
            if (['queued', 'running'].includes(job.status)) {
                job.status = 'interrupted';
                for (const row of job.rows) {
                    if (['creating', 'writing'].includes(row.status)) { row.status = 'uncertain'; row.message = 'Server stopped during an Autodesk write. Check Autodesk before importing again.'; }
                    else if (!['succeeded', 'uncertain'].includes(row.status)) { row.status = 'failed'; row.retryable = true; row.message = 'Interrupted; retry to continue.'; }
                }
            }
        }
        store.save();
    }
    create(owner, body, actor) {
        if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw invalid('A valid requestId is required.');
        let rows;
        try { rows = validate(body.kind, body.records, body.defaults); } catch (err) { throw invalid(err.message); }
        if (rows.some(r => r.errors.length)) throw invalid(rows.filter(r => r.errors.length).map(r => r.label + ': ' + r.errors.join(' ')).join('\n'));
        if (!body.accountId || (body.kind !== 'projects' && !body.projectId)) throw invalid('Select an account and, for members, a project.');
        const inputHash = crypto.createHash('sha256').update(JSON.stringify({
            kind: body.kind, accountId: body.accountId.replace(/^b\./, ''), projectId: body.projectId?.replace(/^b\./, ''), region: body.region,
            rows: rows.map(row => ({ payload: row.payload, initialAdmins: row.initialAdmins }))
        })).digest('hex');
        const existing = this.store.state.jobs.find(j => j.owner === owner && j.requestId === body.requestId);
        if (existing) {
            if (existing.inputHash && existing.inputHash !== inputHash) throw Object.assign(new Error('This request ID already belongs to a different import. Reopen the preview to start a new import.'), { status: 409 });
            return existing;
        }
        const job = { id: crypto.randomUUID(), requestId: body.requestId, owner, actor: actor.email, kind: body.kind, accountId: body.accountId.replace(/^b\./, ''), projectId: body.projectId?.replace(/^b\./, ''), region: body.region, targetName: body.targetName, createdAt: new Date().toISOString(), status: 'queued', rows: rows.map(r => ({ ...r, status: 'queued', attempts: 0 })) };
        job.inputHash = inputHash;
        this.store.state.jobs.push(job); this.store.save();
        return job;
    }
    enqueue(job, credentials) {
        if (this.queue.some(q => q.job.id === job.id) || this.active.has(job.id)) return;
        this.queue.push({ job, credentials });
        void this.drain();
    }
    retry(job, credentials) {
        if (['running', 'queued'].includes(job.status)) throw Object.assign(new Error('This batch is already running.'), { status: 409 });
        for (const row of job.rows) if (row.status === 'failed' && row.retryable) { row.status = 'queued'; row.message = ''; }
        if (!job.rows.some(r => r.status === 'queued')) throw Object.assign(new Error('No safely retryable rows. Resolve uncertain results in Autodesk.'), { status: 409 });
        job.status = 'queued'; this.store.save(); this.enqueue(job, credentials); return job;
    }
    async drain() {
        if (this.busy) return;
        this.busy = true;
        try {
            while (this.queue.length) {
                const { job, credentials } = this.queue.shift();
                this.active.add(job.id);
                try { await this.run(job, credentials); }
                catch (err) {
                    job.status = 'interrupted';
                    for (const row of job.rows) if (!['succeeded', 'uncertain', 'failed'].includes(row.status)) {
                        const writing = ['creating', 'writing'].includes(row.status);
                        row.status = writing ? 'uncertain' : 'failed'; row.retryable = !writing; row.message = message(err);
                    }
                }
                finally { this.active.delete(job.id); this.store.save(); }
            }
        } finally { this.busy = false; }
    }
    async run(job, credentials) {
        job.status = 'running'; this.store.save();
        const options = async () => ({ accessToken: await credentials(), region: job.region });
        let existing;
        try {
            existing = job.kind === 'projects'
                ? await this.aps.getProjectsACC(job.accountId, (await options()).accessToken, job.region)
                : await this.aps.getProjectUsersACC(job.projectId, (await options()).accessToken, job.region);
        } catch (err) {
            for (const row of job.rows.filter(r => r.status === 'queued')) { row.status = 'failed'; row.retryable = true; row.message = 'Could not check existing records: ' + message(err); }
            job.status = 'completed'; this.store.save(); return;
        }
        const lookup = new Map(existing.map(r => [keyOf(job.kind === 'projects' ? r.name : r.email), r]));
        for (const row of job.rows) {
            if (row.status !== 'queued') continue;
            row.attempts++; row.retryable = false;
            try {
                const found = lookup.get(keyOf(row.label));
                if (job.kind === 'projects') {
                    if (!row.projectId && found) throw new Error('A project with this name already exists. Check it in Autodesk; creation was skipped.');
                    if (!row.projectId) {
                        row.status = 'creating'; this.store.save();
                        const project = await this.aps.createProjectACC(job.accountId, row.payload, (await options()).accessToken, job.region);
                        row.projectId = project.id;
                        row.status = 'provisioning'; this.store.save();
                        lookup.set(keyOf(row.label), project);
                    }
                    row.status = 'provisioning'; this.store.save();
                    let active = false;
                    for (let i = 0; i < this.polls; i++) {
                        const project = await this.aps.getProjectACC(row.projectId, (await options()).accessToken, job.region);
                        if (project.status === 'active') { active = true; break; }
                        if (['archived', 'suspended'].includes(project.status)) throw new Error('Project status is ' + project.status + '.');
                        await this.sleep(2000);
                    }
                    if (!active) throw new Error('Project was created but is still activating. Retry later to finish setup.');
                    const admins = [...new Set([job.actor, ...row.initialAdmins].map(keyOf))];
                    const members = await this.aps.getProjectUsersACC(row.projectId, (await options()).accessToken, job.region);
                    for (const email of admins) {
                        const member = members.find(user => keyOf(user.email) === email);
                        const token = (await options()).accessToken;
                        if (member) {
                            await this.aps.updateProjectUserACC(row.projectId, member.id, {
                                products: [{ key: 'projectAdministration', access: 'administrator' }, { key: 'docs', access: 'administrator' }]
                            }, token, job.region);
                        } else {
                            await this.aps.addProjectAdminACC(row.projectId, email, token, job.region);
                        }
                    }
                    row.message = 'Project active; administrators assigned.';
                } else {
                    if (job.kind === 'members' && found) throw new Error('Member already exists. Use Update member access instead.');
                    if (job.kind === 'memberUpdates' && !found) throw new Error('Member not found in this project.');
                    row.status = 'writing'; this.store.save();
                    const token = (await options()).accessToken;
                    const user = job.kind === 'members'
                        ? await this.aps.assignProjectUserACC(job.projectId, row.payload, token, job.region)
                        : await this.aps.updateProjectUserACC(job.projectId, found.id, row.payload, token, job.region);
                    row.userId = user.id || found?.id;
                    lookup.set(keyOf(row.label), user);
                    row.message = job.kind === 'members' ? 'Member assigned.' : 'Member access updated.';
                }
                row.status = 'succeeded';
            } catch (err) {
                const code = statusCode(err);
                const uncertain = ['creating', 'writing'].includes(row.status) && (!code || code === 408 || code >= 500);
                row.status = uncertain ? 'uncertain' : 'failed';
                row.retryable = !uncertain && (Boolean(row.projectId) || [401, 403, 408, 429].includes(code));
                row.message = message(err) + (uncertain ? ' The result is unknown; check Autodesk before submitting again.' : '');
            }
            this.store.save();
            await this.sleep(250);
        }
        job.status = 'completed'; job.completedAt = new Date().toISOString(); this.store.save();
    }
}
module.exports = { Jobs };
