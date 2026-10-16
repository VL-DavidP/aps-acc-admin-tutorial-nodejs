(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AdminCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const projectFields = 'name,type,startDate,endDate,classification,jobNumber,addressLine1,addressLine2,city,stateOrProvince,postalCode,country,latitude,longitude,timezone,constructionType,deliveryMethod,contractType,currentPhase,businessUnitId,template,initialAdminEmails'.split(',');
    const products = 'insight,docs,projectAdministration,autoSpecs,build,cost,designCollaboration,modelCoordination,takeoff,financials,buildingConnected,capitalPlanning,accountAdministration,workshopxr,cloudWorksharing'.split(',');
    const memberFields = ['email', 'firstName', 'lastName', 'companyId', 'roleIds', ...products.map(p => 'products.' + p)];
    const keyOf = value => String(value || '').trim().toLowerCase();
    const emailOK = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    function parse(text) {
        text = String(text).replace(/^\uFEFF/, '');
        const rows = [];
        let row = [], cell = '', quoted = false, closed = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
                if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
                else if (c === '"') { quoted = false; closed = true; }
                else cell += c;
            } else if (c === ',' || c === '\n' || c === '\r') {
                row.push(cell); cell = ''; closed = false;
                if (c !== ',') {
                    if (c === '\r' && text[i + 1] === '\n') i++;
                    rows.push(row); row = [];
                }
            } else if (c === '"') {
                if (cell || closed) throw new Error('Unexpected quote in CSV.');
                quoted = true;
            } else {
                if (closed) throw new Error('Unexpected text after a quoted field.');
                cell += c;
            }
        }
        if (quoted) throw new Error('Unclosed quoted field.');
        row.push(cell);
        if (row.some(c => c.trim())) rows.push(row);
        if (!rows.length) throw new Error('CSV is empty.');
        const headers = rows.shift().map(c => c.trim());
        if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error('Headers must be non-empty and unique.');
        const records = rows.filter(r => r.some(c => c.trim())).map((cells, i) => {
            if (cells.length !== headers.length) throw new Error('Record ' + (i + 2) + ' has a different number of columns.');
            return Object.fromEntries(headers.map((h, j) => [h, cells[j].trim()]));
        });
        return { headers, records };
    }
    function validate(kind, records, defaults = {}) {
        if (!Array.isArray(records) || !records.length || records.length > 1000) throw new Error('Use between 1 and 1,000 rows per batch.');
        const allowed = kind === 'projects' ? projectFields : memberFields;
        if (!['projects', 'members', 'memberUpdates'].includes(kind)) throw new Error('Unknown import type.');
        const seen = new Set();
        return records.map((input, index) => {
            const errors = [], warnings = [];
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Each row must be an object.');
            const source = { ...defaults };
            Object.entries(input).forEach(([k, v]) => { if (v !== '' && v != null) source[k] = v; });
            const data = {};
            Object.entries(source).forEach(([k, v]) => {
                if (!allowed.includes(k)) errors.push('Unknown column: ' + k);
                else if (typeof v !== 'string') errors.push(k + ' must be text.');
                else if (v.trim()) data[k] = v.trim();
            });
            const identity = kind === 'projects' ? data.name : data.email;
            if (!identity) errors.push(kind === 'projects' ? 'name is required.' : 'email is required.');
            if (identity && seen.has(keyOf(identity))) errors.push('Duplicate name/email in this batch.');
            seen.add(keyOf(identity));
            const payload = { ...data };
            let initialAdmins = [];
            if (kind === 'projects') {
                if (!data.type) errors.push('type is required.');
                if (data.name?.length > 255) errors.push('name must be at most 255 characters.');
                if (data.jobNumber?.length > 100) errors.push('jobNumber must be at most 100 characters.');
                for (const field of ['startDate', 'endDate']) {
                    if (data[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(data[field]) || Number.isNaN(Date.parse(data[field])) || new Date(data[field]).toISOString().slice(0, 10) !== data[field])) errors.push(field + ' must be a valid YYYY-MM-DD date.');
                }
                if (data.startDate && data.endDate && data.endDate < data.startDate) errors.push('endDate precedes startDate.');
                if (data.classification && !['production', 'template', 'sample', 'component'].includes(data.classification)) errors.push('Invalid classification.');
                if (data.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: data.timezone }); } catch { errors.push('Invalid timezone.'); } }
                if (data.template) payload.template = { projectId: data.template.replace(/^b\./, '') };
                initialAdmins = (data.initialAdminEmails || '').split('|').map(s => s.trim()).filter(Boolean);
                if (initialAdmins.some(e => !emailOK(e))) errors.push('initialAdminEmails must contain valid emails separated by |.');
                delete payload.initialAdminEmails;
            } else {
                if (data.email && (!emailOK(data.email) || data.email.length > 255)) errors.push('Invalid email.');
                if (data.firstName || data.lastName) warnings.push('Names come from the Autodesk profile; these columns are ignored.');
                delete payload.firstName; delete payload.lastName;
                if (data.roleIds) payload.roleIds = data.roleIds.split('|').map(s => s.trim()).filter(Boolean);
                payload.products = [];
                for (const product of products) {
                    const field = 'products.' + product;
                    if (data[field]) {
                        if (!['member', 'administrator', 'none'].includes(data[field])) errors.push(field + ' must be member, administrator, or none.');
                        payload.products.push({ key: product, access: data[field] });
                    }
                    delete payload[field];
                }
                if (kind === 'members' && !payload.products.length) errors.push('Specify at least one products.* access column.');
                if (kind === 'memberUpdates' && !payload.products.length && !data.companyId && !data.roleIds) errors.push('Specify a company, roles, or product access to update.');
                if (kind === 'memberUpdates' && !payload.products.length) delete payload.products;
            }
            return { row: index + 2, label: identity || 'Row ' + (index + 2), source: data, payload, initialAdmins, errors, warnings };
        });
    }
    function stringify(records) {
        if (!records.length) return '';
        const headers = [...new Set(records.flatMap(r => Object.keys(r)))];
        const quote = value => {
            let s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
            // Keep exported strings from becoming spreadsheet formulas.
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replace(/"/g, '""') + '"';
        };
        return '\uFEFF' + [headers, ...records.map(r => headers.map(h => r[h]))].map(r => r.map(quote).join(',')).join('\r\n');
    }
    return { parse, validate, stringify, projectFields, memberFields, products, keyOf };
});
