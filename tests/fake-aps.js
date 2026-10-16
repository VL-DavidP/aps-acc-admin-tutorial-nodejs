function fakeAPS() {
    const projects = [
        { id: 'project-1', name: 'Harbour Exchange', type: 'Commercial', status: 'active', jobNumber: 'HE-2401', city: 'Sydney', country: 'Australia', timezone: 'Australia/Sydney' },
        { id: 'project-2', name: 'North Campus', type: 'Education', status: 'active', jobNumber: 'NC-2402', city: 'Melbourne', country: 'Australia' },
        { id: 'project-3', name: 'Commercial template', type: 'Commercial', status: 'active', classification: 'template', country: 'Australia' }
    ];
    const users = { 'project-1': [{ id: 'user-1', email: 'alex@example.com', name: 'Alex Morgan', companyName: 'Studio', status: 'active', products: [{ key: 'docs', access: 'member' }, { key: 'projectAdministration', access: 'none' }] }], 'project-2': [] };
    let creates = 0;
    const aps = {
        projects, users, get creates() { return creates; },
        authRefreshMiddleware: (req, res, next) => { req.oAuthToken = { access_token: req.get('X-Test-User') || 'demo' }; req.session = {}; next(); },
        getUserProfile: async token => ({ sub: token.access_token, email: token.access_token + '@example.com', name: 'Demo Administrator' }),
        sessionCredentials: () => async () => 'demo',
        getProjectsACC: async () => structuredClone(projects),
        getProjectACC: async id => structuredClone(projects.find(p => p.id === id)),
        createProjectACC: async (accountId, payload) => {
            const project = { ...payload, id: 'created-' + (++creates), status: 'active' };
            projects.push(project); return structuredClone(project);
        },
        getProjectUsersACC: async id => structuredClone(users[id] || []),
        addProjectAdminACC: async (id, email) => aps.assignProjectUserACC(id, { email, products: [{ key: 'docs', access: 'administrator' }, { key: 'projectAdministration', access: 'administrator' }] }),
        assignProjectUserACC: async (id, payload) => {
            users[id] ||= [];
            const existing = users[id].find(u => u.email === payload.email);
            if (existing) { Object.assign(existing, payload); return structuredClone(existing); }
            const user = { ...payload, id: 'user-' + (users[id].length + 1), status: 'active' }; users[id].push(user); return structuredClone(user);
        },
        updateProjectUserACC: async (id, userId, payload) => {
            const user = (users[id] || []).find(u => u.id === userId);
            if (!user) throw Object.assign(new Error('User not found.'), { status: 404 });
            Object.assign(user, payload); return structuredClone(user);
        },
        removeProjectUserACC: async (id, userId) => { users[id] = (users[id] || []).filter(u => u.id !== userId); }
    };
    return aps;
}
module.exports = { fakeAPS };
