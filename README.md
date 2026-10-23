# Tranquil — personal extension starter

A personal copy of Tranquil v2.21.3. The extension uses **JavaScript, HTML, and CSS**; the optional Convex backend uses **TypeScript**. Chrome and Brave are supported.

This fork runs locally by default. It includes feed removal, Standard/Deep focus sessions, attention guard, deliberate feed-unlock pauses, work passes, and local analytics. It does not connect to John's database, website, Clerk application, or account. No credentials, browser data, or `.env.local` files are included.

## Install and use immediately

1. Extract the starter ZIP to a permanent folder, or clone the Git bundle below.
2. In Chrome, open `chrome://extensions`; in Brave, open `brave://extensions`.
3. Enable Developer mode, click **Load unpacked**, and select the folder containing `manifest.json`.
4. Pin Tranquil. Set your sites, start a focus session, and use Settings to adjust protection.

There is no build step, Node installation, database, or account required to use local blocking. The Sign in control is still present, but reports that account linking has not been configured. Statistics stay in extension storage until you configure your own backend; removing the extension can remove that local history. If another Tranquil copy is installed, disable it while testing this one to avoid overlapping blockers.

For updates, edit files in this same folder and click the circular Reload arrow on the existing extension card. Then refresh affected social tabs. Keep the folder path stable so your unpacked extension retains its identity and data.

## Start coding

If John sent you `Tranquil-Friend-Starter.bundle`, Git restores both the source and its history:

```sh
git clone -b friend-starter /path/to/Tranquil-Friend-Starter.bundle tranquil
cd tranquil
# The bundle is a local file, not a shared GitHub remote.
git remote remove origin
git switch -c my-changes
```

If you started with the source ZIP, it has no Git history. Optionally initialize it:

```sh
git init -b main
git add .
git commit -m "Start my personal Tranquil version"
git switch -c my-changes
```

To work on tests and the optional backend, install Node.js 22+ and run:

```sh
npm ci
npm test
npm run test:backend
```

Make a change, reload the extension, and save your work in a commit:

```sh
git add .
git commit -m "Describe my change"
```

To collaborate online, create your own private GitHub repository, set its URL as `origin`, and push your branch. This handoff has not been published to GitHub. A **branch** is your line of development; a **commit** is a saved change; a **fork** is your independent copy of the project.

## Where to change things

| File | Purpose |
| --- | --- |
| `content.js` | Feed hiding, Facebook cleanup, attention warnings |
| `linkedin-links.js` | Specific LinkedIn notification/post handling |
| `background.js` | Focus sessions, blocking rules, usage, sync |
| `popup.html`, `popup.css`, `popup.js` | Extension popup |
| `options.html`, `options.css`, `options.js` | Settings and analytics |
| `blocked.html`, `blocked.css`, `blocked.js` | Blocked-page experience |
| `config.js` | Your optional public service URLs |
| `convex/` | Optional database schema and backend functions |
| `tests/` | Automated extension and backend tests |

## Optional: your own Convex database

Local mode needs no backend. If you want cloud statistics, create a separate Convex project:

1. Run `npm ci`, then `npx convex dev`. Sign into **your** Convex account, create your project, and let the CLI generate `.env.local` and refresh `convex/_generated/`.
2. Set `CONFIG.convexUrl` in `config.js` to your deployment's `https://YOUR-DEPLOYMENT.convex.cloud` URL.
3. Add that exact origin as `"https://YOUR-DEPLOYMENT.convex.cloud/*"` in `manifest.json` under `host_permissions`.
4. Reload your extension. The anonymous statistics/session functions can now use your deployment. Existing queued local events are eligible for upload when sync resumes.
5. For production, use `npm run convex:deploy` and configure the production deployment URL and host permission explicitly.

The deployment URL is public. Deployment keys and other secrets belong in ignored environment files or Convex environment variables, never inside extension JavaScript. The extension files can be read by anyone who installs it.

## Optional: Clerk and account-based cross-browser sync

The backend source supports Clerk, but a working sign-in website is **not included** in this starter. Merely setting a Convex URL does not give you account-based sync or shared allowances.

To enable these later, create your own Clerk application, set `CLERK_FRONTEND_API_URL` in your Convex deployment, configure a Convex-audience JWT, and host an account-connection webpage. That page must read the `code` query parameter, sign the user in, obtain their Clerk JWT, and call the authenticated `focus:claimClerkLink` mutation with `{ code }`. Configure the Clerk issuer/audience to match `convex/auth.config.ts`. Set `CONFIG.accountConnectUrl` to your webpage. The extension creates and completes its linking request through `focus:beginClerkLink` and `focus:completeClerkLink`.

Each browser must be linked to your own backend and account before shared sessions and shared daily allowances can work. The iPhone app is a separate project and is not included here.

## Prompt to give a coding assistant

> This is my personal fork of the Tranquil Chrome/Brave extension. Read README.md. Start with the local mode and run npm test before and after behavior changes. Keep my service URLs in config.js; do not connect me to the original author's backend. Help me customize [describe what you want]. Keep my installed folder stable when updating it.
