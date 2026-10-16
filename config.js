const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

let { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL, SERVER_SESSION_SECRET, PORT } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET || !APS_CALLBACK_URL || !SERVER_SESSION_SECRET) {
    throw new Error('Configure APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL, and SERVER_SESSION_SECRET in .env. See .env.example.');
}
PORT = PORT || 8080;
const callback = new URL(APS_CALLBACK_URL);
if (!['http:', 'https:'].includes(callback.protocol) || callback.pathname !== '/api/auth/callback') {
    throw new Error('APS_CALLBACK_URL must be an http(s) URL ending in /api/auth/callback.');
}
if (!/^\d+$/.test(String(PORT)) || Number(PORT) > 65535) throw new Error('PORT must be a valid TCP port.');
const APS_REGION = process.env.APS_REGION || 'US';
if (!['US', 'EMEA', 'AUS'].includes(APS_REGION)) throw new Error('APS_REGION must be US, EMEA, or AUS.');

module.exports = {
    APS_CLIENT_ID,
    APS_CLIENT_SECRET,
    APS_CALLBACK_URL,
    SERVER_SESSION_SECRET,
    PORT: Number(PORT),
    APS_REGION,
    HOST: process.env.HOST || '127.0.0.1'
};
