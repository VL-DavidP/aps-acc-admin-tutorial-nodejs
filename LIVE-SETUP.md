# Run the live app from your fork

The normal `npm start` command runs the Express server against Autodesk's real
APIs. It does not load any demo fixtures.

## Start

From this repository:

```powershell
npm ci
npm start
```

Open http://localhost:8080. Use **Sign in with Autodesk**, complete sign-in,
then select your Autodesk account and the account's data region.

For a new checkout, copy `.env.example` to `.env` and supply your APS app's
credentials and a random session secret first. Local credentials and application
history are ignored by Git.

The default callback is `http://localhost:8080/api/auth/callback`. It must match
the callback registered for the APS app. Changing ports requires changing
`PORT`, `APS_CALLBACK_URL`, and the registration. Configuration loads from
this repository's `.env`, regardless of the terminal's current directory.

`APS_REGION` optionally sets the initial region: `US`, `EMEA`, or `AUS`.
Choose the region where the Autodesk account's data is stored; your physical
location does not determine its data region.

## Autodesk access

- Provision the APS client ID as an integration in the target Autodesk account.
- Sign in with an Autodesk user who has the account/project permissions needed
  for the operation. The application does not bypass Autodesk permissions.
- Sign-in requests `data:read`, `data:write`, `account:read`, and
  `account:write`.
- Project creation and member changes happen only when their confirmation
  controls are submitted. Import preview performs local validation.

If the account selector is empty, check account membership and integration
provisioning. If project/member loading fails, check the selected region and
the user's permissions. Errors appear on screen, including inside dialogs.
An expired session returns the app to sign-in.

## Features

The Projects, Project members, Setup presets, Account reports, and Import history
screens are connected to the live backend. Presets and history are stored locally
in `.admin-data/state.json`. Sessions keep Autodesk tokens in server memory;
restart the server and sign in again when necessary.

Existing project settings remain read-only here; the project details dialog
links to Autodesk administration for editing them. See [Revision 1](REVISION-1.md)
for CSV fields, retry rules, and remaining deployment limits.

## Verification

```powershell
npm test
```

Tests cover the real server and session middleware with a substitute Autodesk
client, including login callbacks, refresh, access checks, persistence,
pagination, CSV import, and batch recovery. Tests do not change Autodesk data.

- `GET /health` checks that the server is running; it does not test Autodesk access.
- `GET /api/app` identifies the normal server as `live`.
- `npm run demo` starts the separate mock on port 8081, labelled **LOCAL DEMO**.

Use one server process per local data directory. This version is intended to run
locally with real Autodesk accounts. Public production hosting needs the session,
database, HTTPS, and operational work described in the revision guide.
