/* global AdminCsv */
'use strict';
const C = AdminCsv;
const labels = { name: 'Project name', type: 'Project type', startDate: 'Start date', endDate: 'End date', classification: 'Classification', jobNumber: 'Job number', addressLine1: 'Address line 1', addressLine2: 'Address line 2', city: 'City', stateOrProvince: 'State or province', postalCode: 'Postal code', country: 'Country', latitude: 'Latitude', longitude: 'Longitude', timezone: 'Timezone', constructionType: 'Construction type', deliveryMethod: 'Delivery method', contractType: 'Contract type', currentPhase: 'Current phase', businessUnitId: 'Business unit ID', template: 'Template project ID', initialAdminEmails: 'Additional administrator emails' };
const $ = id => document.getElementById(id);
const state = { authenticated: false, view: 'projects', projects: [], members: [], presets: [], jobs: [], report: null, projectId: '', accountId: '', region: 'US', selectedJob: null, search: '', status: '', loading: false, projectsLoaded: false, membersLoaded: false, projectError: '', memberError: '' };
let contextVersion = 0, memberVersion = 0, polling = null, historyLoading = false;
function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
}
function button(text, action, className = '') {
    const node = el('button', text, className);
    node.type = 'button';
    node.onclick = async () => {
        if (node.disabled) return;
        node.disabled = true;
        try { await action(); } catch (err) { showError(err); } finally { if (node.isConnected) node.disabled = false; }
    };
    return node;
}
function notice(text = '', error = false) {
    for (const id of ['notice', 'dialogNotice']) {
        const node = $(id); node.textContent = text; node.hidden = !text || (id === 'dialogNotice' && !$('dialog').open); node.className = error ? 'error' : '';
    }
}
function showError(err) {
    if (err.status === 401) {
        state.authenticated = false; state.loading = false; clearTimeout(polling);
        if ($('dialog').open) $('dialog').close();
        $('login').textContent = 'Sign in with Autodesk'; $('login').onclick = () => location.assign('/api/auth/login'); render();
    }
    notice(err.message || String(err), true);
}
function params(extra = {}) { return new URLSearchParams({ accountId: state.accountId, projectId: state.projectId, region: state.region, ...extra }); }
async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', ...options.headers } });
    if (!response.ok) {
        let text; try { text = (await response.json()).error; } catch { text = response.statusText; }
        throw Object.assign(new Error(response.status === 401 ? 'Your session expired. Sign in again.' : text || 'Request failed (' + response.status + ').'), { status: response.status });
    }
    return response.status === 204 ? null : response.json();
}
function write(path, body, method = 'POST') { return api(path, { method, body: body == null ? undefined : JSON.stringify(body) }); }
function download(name, rows) {
    const url = URL.createObjectURL(new Blob([C.stringify(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = el('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function table(columns, rows) {
    const wrap = el('div', null, 'table-wrap'), t = el('table'), head = el('tr'), body = el('tbody');
    columns.forEach(col => head.append(el('th', col.title)));
    const thead = el('thead'); thead.append(head); t.append(thead, body); wrap.append(t);
    rows.forEach(row => {
        const tr = el('tr');
        columns.forEach(col => {
            const td = el('td'), value = col.render ? col.render(row) : row[col.key];
            if (value instanceof Node) td.append(value);
            else td.textContent = value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
            tr.append(td);
        });
        body.append(tr);
    });
    if (!rows.length) wrap.append(el('p', 'No records to show.', 'empty'));
    return wrap;
}
function pill(value) { return el('span', value, 'pill ' + value); }
function actions(...nodes) { const div = el('div', null, 'actions'); div.append(...nodes); return div; }
function openDialog(title) { $('dialogTitle').textContent = title; $('dialogBody').replaceChildren(); $('dialogNotice').hidden = true; if (!$('dialog').open) $('dialog').showModal(); return $('dialogBody'); }
function field(label, value = '', type = 'text') {
    const wrapper = el('label', label), input = el('input'); input.type = type; input.value = value || ''; wrapper.append(input); return { wrapper, input };
}
function select(label, options, value) {
    const wrapper = el('label', label), input = el('select');
    options.forEach(([v, text]) => { const option = el('option', text); option.value = v; input.append(option); });
    input.value = value; wrapper.append(input); return { wrapper, input };
}
function project() { return state.projects.find(p => p.id === state.projectId); }
function target() { return project()?.name || $('account').selectedOptions[0]?.textContent || ''; }
function bookmarks() { try { return JSON.parse(localStorage.getItem('acc-bookmarks:' + state.accountId) || '[]'); } catch { return []; } }
function bookmark(id) {
    const list = bookmarks(), next = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
    localStorage.setItem('acc-bookmarks:' + state.accountId, JSON.stringify(next)); render();
}
function setView(view) { state.view = view; state.search = ''; state.status = ''; render(); }
async function loadContext() {
    const version = ++contextVersion;
    memberVersion++; notice();
    state.accountId = $('account').value; state.region = $('region').value; state.projectId = ''; state.projects = []; state.members = []; state.report = null; state.projectsLoaded = false; state.membersLoaded = false; state.projectError = ''; state.memberError = ''; state.search = ''; state.status = ''; state.loading = true; render();
    if (!state.accountId) { state.loading = false; render(); return; }
    try {
        const rows = await api('/api/admin/projects?' + params());
        if (version !== contextVersion) return;
        state.projects = rows; state.projectsLoaded = true;
    } catch (err) {
        if (version === contextVersion) { state.projectError = err.message; throw err; }
    } finally { if (version === contextVersion) { state.loading = false; render(); } }
}
async function loadMembers() {
    const version = ++memberVersion, context = contextVersion;
    const id = state.projectId;
    state.members = []; state.membersLoaded = false; state.memberError = ''; state.loading = true; render();
    try {
        const rows = await api('/api/admin/project/users?' + params());
        if (version === memberVersion && context === contextVersion && id === state.projectId) { state.members = rows; state.membersLoaded = true; }
    } catch (err) {
        if (version === memberVersion && context === contextVersion) { state.memberError = err.message; throw err; }
    } finally { if (version === memberVersion && context === contextVersion) { state.loading = false; render(); } }
}
function filtered(rows) { return rows.filter(r => (!state.status || r.status === state.status) && JSON.stringify(r).toLowerCase().includes(state.search.toLowerCase())); }
function filterBar(rows, repaint) {
    const div = el('div', null, 'filters'), search = el('input'); search.type = 'search'; search.placeholder = 'Search names, emails, or details'; search.value = state.search;
    search.setAttribute('aria-label', 'Search records');
    const statuses = [...new Set(rows.map(r => r.status).filter(Boolean))];
    const status = select('Status', [['', 'All statuses'], ...statuses.map(s => [s, s])], state.status).input; status.setAttribute('aria-label', 'Filter by status');
    search.oninput = () => { state.search = search.value; repaint(); };
    status.onchange = () => { state.status = status.value; repaint(); };
    div.append(search, status); return div;
}
function render() {
    document.querySelectorAll('nav button').forEach(b => { b.classList.toggle('active', b.dataset.view === state.view); b.disabled = !state.authenticated; });
    const root = $('content'); root.replaceChildren();
    $('account').disabled = !state.authenticated;
    if (!state.authenticated) {
        root.append(el('p', 'AUTODESK CONSTRUCTION CLOUD', 'eyebrow'), el('h1', 'Your Autodesk workspace'), el('p', 'Sign in with Autodesk to browse your accounts and manage projects. Live changes are sent to your selected Autodesk account.'));
        return;
    }
    const labels = { projects: 'Projects', members: 'Project members', reports: 'Account reports', presets: 'Setup presets', history: 'Import history' };
    root.append(el('p', 'ACCOUNT OPERATIONS / ' + state.region, 'eyebrow'), el('h1', labels[state.view]));
    if (state.loading && ['projects', 'members', 'reports'].includes(state.view)) { root.append(el('p', 'Loading Autodesk data…', 'muted')); return; }
    if (['presets', 'history'].includes(state.view)) { state.view === 'presets' ? renderPresets(root) : renderHistory(root); return; }
    if (!state.accountId) { root.append(el('p', 'Select an Autodesk account to continue.', 'empty')); return; }
    if (state.view === 'projects') renderProjects(root);
    if (state.view === 'members') renderMembers(root);
    if (state.view === 'reports') renderReports(root);
}
function renderProjects(root) {
    if (!state.projectsLoaded) { root.append(el('p', state.projectError || 'Load the project list before creating or importing projects.', 'error'), button('Retry loading projects', loadContext)); return; }
    const stats = el('div', null, 'stats');
    [['Projects', state.projects.length], ['Active', state.projects.filter(p => p.status === 'active').length], ['Bookmarked', bookmarks().length]].forEach(([label, n]) => { const box = el('div', null, 'stat'); box.append(el('strong', n), el('span', label)); stats.append(box); });
    root.append(stats, actions(button('Create project', () => projectForm(), 'primary'), button('Import projects CSV', () => pickCSV('projects')), button('Download template', () => download('projects-template.csv', [{ name: 'Example Project', type: 'Commercial', timezone: 'Australia/Sydney', classification: 'production', template: '', initialAdminEmails: '' }])), button('Refresh', loadContext)));
    const output = el('div');
    const repaint = () => {
        const rows = filtered(state.projects).sort((a, b) => Number(bookmarks().includes(b.id)) - Number(bookmarks().includes(a.id)));
        output.replaceChildren(actions(button('Export filtered projects', () => download('projects.csv', rows))));
        output.append(table([
            { title: 'Project', render: p => button(p.name, () => details(p), 'link') },
            { title: 'Status', render: p => pill(p.status) }, { title: 'Job number', key: 'jobNumber' }, { title: 'Type', key: 'type' }, { title: 'Location', render: p => [p.city, p.country].filter(Boolean).join(', ') },
            { title: 'Actions', render: p => actions(button('Members', async () => { state.projectId = p.id; state.view = 'members'; state.search = ''; state.status = ''; await loadMembers(); }), button(bookmarks().includes(p.id) ? '★ Saved' : '☆ Save', () => bookmark(p.id))) }
        ], rows));
    };
    root.append(filterBar(state.projects, repaint), output); repaint();
}
function details(p) {
    const body = openDialog(p.name);
    const link = el('a', 'Open project administration in Autodesk', 'button'); link.href = 'https://acc.autodesk.com/admin/projects/' + encodeURIComponent(p.id); link.target = '_blank'; link.rel = 'noopener';
    body.append(el('p', 'Project details are read-only here. Use Autodesk to edit existing project settings.', 'muted'), actions(button('Create from these settings', () => projectForm(p)), link), el('pre', JSON.stringify(p, null, 2)));
}
function projectForm(source = {}) {
    const body = openDialog('Create project'), form = el('form'), grid = el('div', null, 'form-grid');
    const preset = select('Apply saved preset', [['', 'No preset'], ...state.presets.map(p => [p.id, p.name])], '');
    const fields = {};
    for (const key of C.projectFields) {
        const value = key === 'name' ? '' : key === 'template' ? source.classification === 'template' ? source.id : '' : key === 'classification' && source.classification === 'template' ? 'production' : source[key];
        const f = field(labels[key], typeof value === 'string' ? value : '', key.endsWith('Date') ? 'date' : 'text');
        fields[key] = f.input; if (['name', 'type'].includes(key)) f.input.required = true; grid.append(f.wrapper);
    }
    preset.input.onchange = () => { const defaults = state.presets.find(p => p.id === preset.input.value)?.defaults || {}; for (const key of Object.keys(fields)) if (key !== 'name') fields[key].value = defaults[key] || ''; };
    const submit = el('button', 'Preview project', 'primary'); submit.type = 'submit';
    form.append(preset.wrapper, grid, submit); form.onsubmit = e => { e.preventDefault(); try { preview('projects', [Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, input.value]))]); } catch (err) { showError(err); } };
    body.append(el('p', 'Review before creating. Separate additional administrator emails with |.', 'hint'), form);
}
function renderMembers(root) {
    if (!state.projectsLoaded) { root.append(el('p', state.projectError || 'Load projects to select a project.'), button('Load projects', loadContext)); return; }
    const picker = select('Project', [['', 'Select a project'], ...state.projects.map(p => [p.id, p.name])], state.projectId);
    picker.input.onchange = () => { state.projectId = picker.input.value; state.search = ''; state.status = ''; if (state.projectId) loadMembers().catch(showError); else { state.members = []; state.membersLoaded = false; render(); } };
    root.append(picker.wrapper);
    if (!state.projectId) return;
    if (!state.membersLoaded) { root.append(el('p', state.memberError || 'Load the member list before editing access.', 'error'), button('Retry loading members', loadMembers)); return; }
    root.append(actions(button('Add member', () => memberForm(), 'primary'), button('Import members CSV', () => pickCSV('members')), button('Update access from CSV', () => pickCSV('memberUpdates')), button('Download template', () => download('members-template.csv', [{ email: 'person@example.com', companyId: '', roleIds: '', 'products.docs': 'member', 'products.projectAdministration': 'none' }])), button('Refresh', loadMembers)));
    const output = el('div');
    const repaint = () => {
        const rows = filtered(state.members);
        output.replaceChildren(actions(button('Export filtered members', () => download('members.csv', rows))));
        output.append(table([{ title: 'Member', key: 'email' }, { title: 'Name', key: 'name' }, { title: 'Company', key: 'companyName' }, { title: 'Status', render: p => pill(p.status) }, { title: 'Product access', render: p => (p.products || []).map(x => x.key + ': ' + x.access).join('; ') }, { title: 'Actions', render: p => actions(button('Edit access', () => memberForm(p)), button('Remove', () => removeMember(p), 'danger')) }], rows));
    };
    root.append(filterBar(state.members, repaint), output); repaint();
}
function memberForm(member) {
    const body = openDialog(member ? 'Edit member access' : 'Add project member'), form = el('form'), grid = el('div', null, 'form-grid');
    const email = field('Email', member?.email, 'email'), company = field('Company ID (optional)', member?.companyId), roles = field('Role IDs, separated by | (optional)', (member?.roleIds || []).join('|'));
    email.input.required = true; email.input.readOnly = Boolean(member);
    grid.append(email.wrapper, company.wrapper, roles.wrapper);
    const fields = {};
    C.products.forEach(key => {
        const current = member?.products?.find(p => p.key === key)?.access || '';
        const f = select(key, [['', member ? 'Leave unchanged' : 'Not specified'], ['none', 'None'], ['member', 'Member'], ['administrator', 'Administrator']], current);
        fields[key] = f.input; grid.append(f.wrapper);
    });
    const save = el('button', member ? 'Review access changes' : 'Preview member', 'primary'); save.type = 'submit';
    form.append(grid, save);
    form.onsubmit = e => {
        e.preventDefault();
        try {
        const record = { email: email.input.value, companyId: company.input.value, roleIds: roles.input.value };
        Object.entries(fields).forEach(([key, input]) => { if (input.value) record['products.' + key] = input.value; });
        if (!member) { preview('members', [record]); return; }
        const row = C.validate('memberUpdates', [record])[0];
        if (row.errors.length) throw new Error(row.errors.join(' '));
        const projectId = state.projectId, context = params().toString();
        const review = openDialog('Confirm member access');
        review.append(el('p', 'Update ' + member.email + ' in ' + target() + '?'), el('pre', JSON.stringify(row.payload, null, 2)), button('Apply changes', async () => {
            await write('/api/admin/project/users/' + encodeURIComponent(member.id) + '?' + context, row.payload, 'PATCH');
            $('dialog').close(); notice('Member access updated.'); if (state.projectId === projectId) await loadMembers();
        }, 'primary'));
        } catch (err) { showError(err); }
    };
    body.append(el('p', 'Changes affect this project. To revoke a product, choose None. Company and role fields can assign values; clearing them is not supported in this revision.', 'hint'), form);
}
function removeMember(member) {
    const projectId = state.projectId, context = params().toString(), body = openDialog('Remove project member');
    body.append(el('p', 'Remove ' + member.email + ' from ' + target() + '? This revokes their membership in this project.'), button('Remove member', async () => {
        await write('/api/admin/project/users/' + encodeURIComponent(member.id) + '?' + context, null, 'DELETE'); $('dialog').close(); notice('Member removed.'); if (state.projectId === projectId) await loadMembers();
    }, 'danger'));
}
function pickCSV(kind) {
    const context = params().toString();
    const input = el('input'); input.type = 'file'; input.accept = '.csv,text/csv'; input.className = 'file-input';
    input.onchange = async () => {
        try {
            const file = input.files[0]; if (!file) return;
            if (file.size > 2 * 1024 * 1024) throw new Error('Use a CSV smaller than 2 MB.');
            const parsed = C.parse(await file.text());
            if (context !== params().toString()) throw new Error('The selected account or project changed. Choose the CSV again for the current target.');
            preview(kind, parsed.records);
        } catch (err) { showError(err); } finally { input.remove(); }
    };
    input.oncancel = () => input.remove();
    document.body.append(input); input.click();
}
function preview(kind, records) {
    if (!state.authenticated || !state.accountId || !state.projectsLoaded || (kind !== 'projects' && (!state.projectId || !state.membersLoaded))) throw new Error('Load the target account or project before preparing an import.');
    const context = { accountId: state.accountId, projectId: state.projectId, region: state.region, targetName: kind === 'projects' ? $('account').selectedOptions[0]?.textContent : target() };
    const body = openDialog('Review ' + (kind === 'projects' ? 'projects' : kind === 'members' ? 'new members' : 'member access updates'));
    const preset = select('Project defaults', [['', 'No preset'], ...state.presets.map(p => [p.id, p.name])], '');
    const output = el('div'), requestId = crypto.randomUUID();
    function paint() {
        const defaults = kind === 'projects' ? state.presets.find(p => p.id === preset.input.value)?.defaults || {} : {};
        const rows = C.validate(kind, records, defaults);
        const existing = new Map((kind === 'projects' ? state.projects : state.members).map(r => [C.keyOf(kind === 'projects' ? r.name : r.email), r]));
        rows.forEach(row => {
            if (existing.has(C.keyOf(row.label)) && kind !== 'memberUpdates') row.errors.push('Already exists in selected account/project.');
            if (!existing.has(C.keyOf(row.label)) && kind === 'memberUpdates') row.errors.push('Member not found in selected project.');
        });
        const errors = rows.filter(r => r.errors.length).length;
        const confirm = button('Submit ' + rows.length + ' rows', async () => {
            confirm.disabled = true;
            preset.input.disabled = true;
            try {
                const job = await write('/api/admin/jobs?region=' + context.region, { ...context, kind, records, defaults, requestId });
                $('dialog').close(); state.selectedJob = job.id; state.view = 'history'; await loadHistory(); notice('Batch submitted. You can follow progress in Import history.');
            } catch (err) { confirm.disabled = false; throw err; }
        }, 'primary');
        confirm.disabled = Boolean(errors) || !context.accountId;
        output.replaceChildren(el('p', 'Target: ' + context.targetName + ' · ' + context.region + ' · ' + rows.length + ' rows · ' + errors + ' invalid'));
        if (kind === 'projects') output.append(el('p', 'Projects will be created in Autodesk. You will be assigned as an administrator. Existing project names are blocked.', 'hint'));
        output.append(table([{ title: 'Row', key: 'row' }, { title: 'Name / email', key: 'label' }, { title: 'Validation', render: r => r.errors.join(' ') || r.warnings.join(' ') || 'Ready' }, { title: 'Values to send', render: r => ({ ...r.payload, ...(r.initialAdmins.length ? { initialAdmins: r.initialAdmins } : {}) }) }], rows.slice(0, 100)));
        if (rows.length > 100) output.append(el('p', 'Showing the first 100 rows. Validation covers the entire file.'));
        output.append(actions(confirm, button('Download validation report', () => download('validation.csv', rows.map(r => ({ row: r.row, nameOrEmail: r.label, errors: r.errors.join('; '), warnings: r.warnings.join('; ') }))))));
    }
    if (kind === 'projects') { body.append(preset.wrapper); preset.input.onchange = () => { try { paint(); } catch (err) { showError(err); } }; }
    body.append(output); paint();
}
function renderPresets(root) {
    root.append(el('p', 'Reusable defaults for new projects. Non-empty CSV cells override these values.', 'muted'), actions(button('New preset', () => presetForm(), 'primary')));
    root.append(table([{ title: 'Preset', key: 'name' }, { title: 'Defaults', key: 'defaults' }, { title: 'Actions', render: p => actions(button('Copy / edit', () => presetForm(p)), button('Delete', async () => {
        const body = openDialog('Delete preset');
        body.append(el('p', 'Delete ' + p.name + '? Existing projects are unaffected.'), button('Delete preset', async () => { await write('/api/admin/presets/' + p.id, null, 'DELETE'); state.presets = await api('/api/admin/presets'); $('dialog').close(); render(); }, 'danger'));
    }, 'danger')) }], state.presets));
}
function presetForm(source = {}) {
    const body = openDialog(source.id ? 'Save revised preset as a new copy' : 'New project preset'), form = el('form'), grid = el('div', null, 'form-grid'), name = field('Preset name', source.name);
    name.input.required = true; form.append(name.wrapper);
    const fields = {};
    C.projectFields.filter(k => k !== 'name').forEach(k => { const f = field(labels[k], source.defaults?.[k]); fields[k] = f.input; grid.append(f.wrapper); });
    const save = el('button', 'Save preset', 'primary'); save.type = 'submit'; form.append(grid, save);
    form.onsubmit = async e => {
        e.preventDefault(); save.disabled = true;
        try {
            const defaults = Object.fromEntries(Object.entries(fields).filter(([, input]) => input.value).map(([k, input]) => [k, input.value]));
            await write('/api/admin/presets', { name: name.input.value, defaults }); state.presets = await api('/api/admin/presets'); $('dialog').close(); render();
        } catch (err) { showError(err); save.disabled = false; }
    };
    body.append(form);
}
function renderReports(root) {
    root.append(el('p', 'Find people across the account and compare product access. Reports read project memberships; they do not change access.', 'muted'));
    root.append(actions(button('Generate account access report', async () => {
        const context = params().toString(), accountId = state.accountId, region = state.region; notice('Reading project memberships. Larger accounts may take a few minutes.');
        const report = await api('/api/admin/report?' + context);
        if (accountId !== state.accountId || region !== state.region) return;
        state.report = report; notice(report.failures.length ? report.failures.length + ' projects could not be read. See report coverage below.' : 'Account report ready.'); render();
    }, 'primary')));
    if (!state.report) return;
    const report = state.report;
    root.append(el('p', report.projectCount + ' projects · ' + report.rows.length + ' memberships · Generated ' + new Date(report.generatedAt).toLocaleString()));
    if (report.failures.length) {
        root.append(el('p', 'Incomplete coverage — these projects could not be read:', 'warning'), table([{ title: 'Project', key: 'name' }, { title: 'Error', key: 'error' }], report.failures), actions(button('Export coverage failures', () => download('report-failures.csv', report.failures))));
    }
    const output = el('div');
    const repaint = () => { const rows = filtered(report.rows); output.replaceChildren(actions(button('Export filtered report', () => download('account-access.csv', rows))), table([{ title: 'Project', key: 'projectName' }, { title: 'Email', key: 'email' }, { title: 'Name', key: 'name' }, { title: 'Company', key: 'company' }, { title: 'Products', render: r => (r.products || []).map(p => p.key + ': ' + p.access).join('; ') }, { title: 'Roles', key: 'roles' }], rows)); };
    root.append(filterBar(report.rows, repaint), output); repaint();
}
async function loadHistory() {
    if (!state.authenticated || historyLoading) return;
    historyLoading = true;
    clearTimeout(polling);
    try {
    const previous = new Map(state.jobs.map(j => [j.id, j.status]));
    state.jobs = await api('/api/admin/jobs');
    const changed = state.jobs.some(j => j.status === 'completed' && ['running', 'queued'].includes(previous.get(j.id)));
    if (changed && state.accountId) {
        const version = contextVersion, rows = await api('/api/admin/projects?' + params());
        if (version === contextVersion) { state.projects = rows; state.projectsLoaded = true; }
        if (state.view === 'members' && state.projectId) await loadMembers();
    }
    if (state.view === 'history' || changed) render();
    } finally {
        historyLoading = false;
        if (state.authenticated && state.jobs.some(j => ['queued', 'running'].includes(j.status))) polling = setTimeout(() => loadHistory().catch(showError), 2000);
    }
}
function renderHistory(root) {
    root.append(el('p', 'Batches and results are stored by this app, scoped to your Autodesk user. Refresh this page to reconnect to a running batch.', 'muted'), actions(button('Refresh history', loadHistory), button('Download member change log', async () => download('member-changes.csv', await api('/api/admin/events')))));
    root.append(table([{ title: 'Created', render: j => new Date(j.createdAt).toLocaleString() }, { title: 'Target', key: 'targetName' }, { title: 'Type', key: 'kind' }, { title: 'Status', render: j => pill(j.status) }, { title: 'Progress', render: j => j.rows.filter(r => ['succeeded', 'failed', 'uncertain'].includes(r.status)).length + ' / ' + j.rows.length }, { title: 'Results', render: j => button('View batch', () => { state.selectedJob = j.id; render(); }) }], state.jobs));
    const job = state.jobs.find(j => j.id === state.selectedJob); if (!job) return;
    const card = el('section', null, 'card'); card.style.marginTop = '24px';
    const completed = job.rows.filter(r => ['succeeded', 'failed', 'uncertain'].includes(r.status)).length, progress = el('progress'); progress.max = job.rows.length; progress.value = completed; progress.setAttribute('aria-label', 'Batch progress');
    card.append(el('h3', job.targetName + ' / ' + job.kind), el('p', 'Submitted by ' + job.actor + ' · ' + job.region), progress);
    const retry = button('Retry safely failed rows', async () => { await write('/api/admin/jobs/' + job.id + '/retry'); await loadHistory(); }, 'primary');
    retry.disabled = ['running', 'queued'].includes(job.status) || !job.rows.some(r => r.status === 'failed' && r.retryable);
    card.append(actions(retry, button('Download results', () => download('batch-' + job.id + '.csv', job.rows.map(r => ({ row: r.row, nameOrEmail: r.label, status: r.status, projectId: r.projectId, userId: r.userId, attempts: r.attempts, retryable: r.retryable, message: r.message }))))));
    if (job.rows.some(r => r.status === 'uncertain')) card.append(el('p', 'Some writes have an unknown outcome. Check Autodesk before importing those rows again; automatic retry is blocked.', 'warning'));
    card.append(table([{ title: 'Row', key: 'row' }, { title: 'Name / email', key: 'label' }, { title: 'Status', render: r => pill(r.status) }, { title: 'Result', key: 'message' }, { title: 'Project ID', key: 'projectId' }], job.rows)); root.append(card);
}
$('closeDialog').onclick = () => $('dialog').close();
$('account').onchange = () => loadContext().catch(showError);
$('region').onchange = () => loadContext().catch(showError);
document.querySelectorAll('nav button').forEach(node => node.onclick = () => { setView(node.dataset.view); if (state.view === 'history') loadHistory().catch(showError); });
async function init() {
    $('login').onclick = () => location.assign('/api/auth/login');
    const app = await api('/api/app');
    $('mode').textContent = app.mode === 'demo' ? 'LOCAL DEMO' : 'LIVE AUTODESK';
    document.title = app.mode === 'demo' ? 'ACC Admin · Local demo' : 'ACC Admin · Live';
    state.region = app.defaultRegion; $('region').value = app.defaultRegion;
    render();
    const authError = new URLSearchParams(location.search).get('authError');
    if (authError) { notice(authError, true); history.replaceState(null, '', location.pathname); }
    const response = await fetch('/api/auth/profile');
    if (response.status === 401) return;
    if (!response.ok) throw new Error('Could not load your Autodesk profile.');
    const profile = await response.json();
    state.authenticated = true;
    $('login').textContent = 'Sign out · ' + profile.name;
    $('login').onclick = () => location.assign('/api/auth/logout');
    const results = await Promise.allSettled([api('/api/hubs'), api('/api/admin/presets')]);
    if (results[0].status === 'fulfilled') {
        const accounts = results[0].value;
        $('account').replaceChildren(new Option(accounts.length ? 'Select account' : 'No accessible ACC accounts', ''), ...accounts.map(a => new Option(a.attributes.name, a.id)));
        if (!accounts.length) notice('No ACC accounts were returned. Check your Autodesk account membership and APS integration provisioning.', true);
    } else { $('account').replaceChildren(new Option('Account loading failed — reload to retry', '')); showError(results[0].reason); }
    if (results[1].status === 'fulfilled') state.presets = results[1].value; else showError(results[1].reason);
    await loadHistory(); render();
}
init().catch(showError);
