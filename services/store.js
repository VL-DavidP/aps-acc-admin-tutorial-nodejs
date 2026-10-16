const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class Store {
    constructor(directory = process.env.ADMIN_DATA_DIR || path.join(__dirname, '..', '.admin-data')) {
        this.directory = directory;
        fs.mkdirSync(directory, { recursive: true });
        this.file = path.join(directory, 'state.json');
        this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { jobs: [], presets: [], events: [] };
    }
    save() {
        const temp = this.file + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        fs.renameSync(temp, this.file);
    }
    event(owner, action, target) {
        this.state.events.push({ id: crypto.randomUUID(), owner, action, target, at: new Date().toISOString() });
        this.save();
    }
}
module.exports = { Store };
