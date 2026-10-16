const { SdkManagerBuilder, ResiliencyConfiguration } = require('@aps_sdk/autodesk-sdkmanager');
const { AuthenticationClient, Scopes } = require('@aps_sdk/authentication');
const { DataManagementClient } = require('@aps_sdk/data-management');
const { AdminClient } = require('@aps_sdk/construction-account-admin');
const settings = require('../config.js');
const { createAuthHandlers } = require('./auth.js');
const { collectPages } = require('./pagination.js');

const sdk = SdkManagerBuilder.create().build();
// Reads can retry. A failed write must pass through the app's recovery checks.
const writeSdk = SdkManagerBuilder.create().addResiliencyConfiguration(new ResiliencyConfiguration(0, 0, 0, 31000)).build();
const authenticationClient = new AuthenticationClient({ sdkManager: writeSdk });
const dataManagementClient = new DataManagementClient({ sdkManager: sdk });
const adminClient = new AdminClient({ sdkManager: sdk });
const writeClient = new AdminClient({ sdkManager: writeSdk });
const scopes = [Scopes.DataRead, Scopes.DataWrite, Scopes.AccountRead, Scopes.AccountWrite];
const service = module.exports = createAuthHandlers(authenticationClient, settings, scopes);
const nativeId = id => id.replace(/^b\./, '');
const readOptions = (token, region) => ({ accessToken: token, region, options: { timeout: 30000 } });
const writeOptions = readOptions;

service.getUserProfile = token => authenticationClient.getUserInfo(token.access_token, { options: { timeout: 30000 } });
service.getHubs = async token => {
    const response = await dataManagementClient.getHubs({ accessToken: token.access_token, options: { timeout: 30000 } });
    if (!Array.isArray(response.data)) throw Object.assign(new Error('Autodesk did not return an account list.'), { status: 502 });
    return response.data.filter(item => item.id?.startsWith('b.'));
};
service.getProjects = async (hubId, token) => {
    const response = await dataManagementClient.getHubProjects(hubId, { accessToken: token.access_token });
    return response.data.filter(item => item.attributes?.extension?.data?.projectType === 'ACC');
};
service.getProjectsACC = (accountId, token, region) => collectPages(offset =>
    adminClient.getProjects(nativeId(accountId), { ...readOptions(token, region), offset, limit: 200, filterPlatform: ['acc'] }));
service.getProjectUsersACC = (projectId, token, region) => collectPages(offset =>
    adminClient.getProjectUsers(nativeId(projectId), { ...readOptions(token, region), offset, limit: 200 }));
service.getProjectACC = (projectId, token, region) =>
    adminClient.getProject(nativeId(projectId), readOptions(token, region));
service.createProjectACC = (accountId, payload, token, region) =>
    writeClient.createProject(nativeId(accountId), payload, writeOptions(token, region));
service.assignProjectUserACC = (projectId, payload, token, region) =>
    writeClient.assignProjectUser(nativeId(projectId), payload, writeOptions(token, region));
service.updateProjectUserACC = (projectId, userId, payload, token, region) =>
    writeClient.updateProjectUser(nativeId(projectId), userId, payload, writeOptions(token, region));
service.removeProjectUserACC = (projectId, userId, token, region) =>
    writeClient.removeProjectUser(nativeId(projectId), userId, writeOptions(token, region));
service.addProjectAdminACC = (projectId, email, token, region) => service.assignProjectUserACC(projectId, {
    email,
    products: [{ key: 'projectAdministration', access: 'administrator' }, { key: 'docs', access: 'administrator' }]
}, token, region);
