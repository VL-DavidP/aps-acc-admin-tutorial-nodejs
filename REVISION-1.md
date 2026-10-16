# Revision 1 — ACC administration workspace

This revision extends the Autodesk tutorial into a local administration workspace. It uses the existing Autodesk Platform Services app registration and Autodesk permissions.

The personal fork runs the real Autodesk integration with `npm start`.
See [Live setup](LIVE-SETUP.md) for configuration, sign-in, and verification.

## Run the real app

1. Install Node.js 20.10 or later and run `npm install`.
2. Copy `.env.example` to `.env`. Enter your APS credentials and a long random session secret. Keep the callback URL identical to the callback registered for your APS app.
3. Run `npm start`, open http://localhost:8080, and sign in again. This revision uses a separate session cookie and requests `data:read`, `data:write`, `account:read`, and `account:write`.
4. Select the Autodesk account and its data region (US, Europe, or Australia).

Stop another server using port 8080 before starting this copy. Changing the port also requires changing the callback URL here and in your APS application registration. The account must have the APS integration provisioned. Autodesk enforces the signed-in user's permissions.

## Explore without Autodesk

Run `npm run demo` and open http://127.0.0.1:8081. The screen says **LOCAL DEMO**. All operations use in-memory mock projects; there are no Autodesk calls. Demo history and presets use a fresh temporary directory each time the demo starts.

Run `npm test` for automated tests of parsing, validation, batch recovery, duplicate protection, permissions updates, and API ownership.

## Projects

- Browse/search/filter projects; bookmark projects in your browser; export filtered rows.
- Open full project details or follow the link to Autodesk administration.
- Create a project using the form or **Import projects CSV**.
- Copy supported creation settings from a project. A project classified as a template also supplies its template ID.
- Download the starter CSV from the Projects screen. Existing templates in `template files` also work.

Required CSV fields: `name`, `type`. A saved preset can supply type. Supported optional fields:

```text
startDate,endDate,classification,jobNumber,addressLine1,addressLine2,city,
stateOrProvince,postalCode,country,latitude,longitude,timezone,constructionType,
deliveryMethod,contractType,currentPhase,businessUnitId,template,initialAdminEmails
```

Use YYYY-MM-DD dates, an IANA timezone such as Australia/Sydney, and a template project's ID in `template`. Separate additional administrator emails with `|`. The signed-in user is also assigned Project Administration and Docs administrator access.

The importer accepts quoted commas, quotes, embedded newlines, UTF-8 BOM, and Windows/Unix/Mac line endings. Limits are 1,000 rows and 2 MB per request; rows are processed one at a time. Non-empty CSV values override saved preset defaults.

Preview validates every row and displays the first 100. Download the validation report for the full file. Duplicate names within a file and existing project names in an account block creation. Additional Autodesk constraints, product entitlements, project type values, template access, and account-specific rules are checked by Autodesk when a row is submitted.

## Members and access

Select a project in **Project members**:

- Add a member with the form or import new members.
- Edit a member's company ID, role IDs, and product permissions.
- Use **Update access from CSV** for existing members identified by email.
- Review and confirm changes or removal before submission.

Member CSV fields are `email`, optional `companyId`, `roleIds`, and `products.<key>`. Separate role IDs with `|`. Product access values are `none`, `member`, or `administrator`.

Example:

```csv
email,products.docs,products.projectAdministration
person@example.com,member,none
```

First/last-name columns from the original tutorial are accepted with a warning and ignored: Autodesk profile names are not edited through project membership assignment. New-member imports require at least one product. Access-update imports require at least one company, role, or product change. Blank fields leave values unchanged; this revision does not clear existing company/role assignments. Product access is explicitly revoked by setting it to `none`.

## Presets, reports, and history

**Setup presets** stores reusable project defaults for the signed-in Autodesk user. Revise a preset by saving a new copy; delete the previous preset when it is no longer useful. Presets reference Autodesk template IDs but do not create or modify Autodesk templates.

**Account reports** reads memberships across the selected account's projects. Search for a person's email or compare product access, then export the filtered report. Failed project reads are shown separately and can be exported, so partial coverage remains visible. Nested fields are exported as JSON text rather than discarded.

**Import history** shows row progress, attempts, errors, and created IDs. It survives browser refreshes and server restarts. Results can be downloaded as CSV. Direct member edits/removals have a separate downloadable change log. History and presets are scoped to the signed-in user.

## Failure and retry behaviour

- Repeated submission of the same request ID returns the same job.
- Before creating a project, the worker checks existing project names again.
- A project's ID is saved immediately after creation. If activation or administrator assignment fails, **Retry safely failed rows** resumes that existing project's setup.
- Activation polling is bounded to roughly two minutes per attempt. A still-pending project can be resumed later.
- Rate limits and authentication/permission failures may be retried after correcting the cause. Invalid payloads must be corrected in a new import.
- A lost connection or server error during a create/assign write can leave the result unknown. Such rows are marked **uncertain** and automatic retry is blocked. Check Autodesk before submitting them again.
- On restart, unstarted/interrupted read/setup steps can be retried after signing in. Writes that were in progress become uncertain.

This is defensive duplicate prevention, not a guarantee of exactly-once writes across Autodesk and local storage. Two separate tools/users can create duplicate names concurrently, and a crash between Autodesk acceptance and saving the returned ID requires manual reconciliation.

## Storage and deployment limits

Local data lives in `.admin-data/state.json`, or the directory set in `ADMIN_DATA_DIR`. It contains project/member import data, presets, actor emails, and change history; treat it as private and back it up. It is ignored by Git. Tokens are kept in server-side sessions in memory, not in history or browser cookies. Restarting requires signing in again. Jobs refresh credentials while the process remains alive.

Run one server process against this JSON store. This revision is intended for local/team evaluation; it is not a completed public hosting deployment. Shared production hosting needs a durable session store, a database/worker queue, HTTPS/proxy configuration, backups, retention rules, and operational monitoring.

## Supported API boundary

This revision supports project creation/read, project-member assignment/update/removal, and access reporting. The installed Construction Account Admin SDK does not expose a general ACC project-details PATCH operation. Existing project settings are read-only here and edited through Autodesk. Project deletion, archive/status changes, model viewing, and file management are not implemented.

API references:
- [Autodesk hub administration tutorial](https://aps.autodesk.com/en/docs/acc/v1/tutorials/admin)
- [Official Node SDK examples](https://github.com/autodesk-platform-services/aps-sdk-node/blob/main/samples/accountadmin.ts)

## Main files

- `wwwroot/main.js`: workspace screens, forms, preview, and progress polling.
- `wwwroot/csv.js`: shared browser/server parser, validation, and CSV export.
- `routes/admin.js`: authenticated routes, presets, reports, and ownership checks.
- `services/jobs.js`: sequential batches and recovery checkpoints.
- `services/store.js`: local atomic JSON persistence.
- `services/aps.js`: Autodesk API calls.
- `services/auth.js`: OAuth callbacks, session checks, and credential refresh.
- `tests/revision.test.js`: automated regression tests.
- `tests/demo-server.js`: isolated local mock.

The previous tutorial table/sidebar scripts have been replaced by the new workspace.
