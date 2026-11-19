# AGENTS.md

Guidance for coding agents working in this repository. Read `README.md` for what the bridge
does and how it is used; this file covers how to change it.

## What lives here

`github-copilot-openai-bridge`: an OpenAI-compatible API on top of `@github/copilot-sdk`.

- `server.mjs` — the whole bridge (single file, no build step).
- `package.json`, `package-lock.json` — the only dependency is `@github/copilot-sdk`.
- `acceptance.test.mjs`, `multi-session.test.mjs` — live tests (see below).
- `run.cmd`, `run.ps1` — manual launchers.

The Hermes Agent plugin lives in its own repository,
[`paq85/hermes-plugin-github-copilot`](https://github.com/paq85/hermes-plugin-github-copilot).
It downloads a **pinned release tag** of this repository (`vX.Y.Z`) from GitHub, runs `npm ci`
and starts `server.mjs` with `PORT`, `BRIDGE_API_KEY`, `IDLE_EXIT_MS` and `NO_COLOR`. Those
variables, the `server.mjs` entry point, the startup line `OpenAI-compatible API on http://...`
and exit code 3 for "port already in use" are an interface the plugin relies on: changing any of
them is a MAJOR change and needs a matching plugin release.

## Versioning and releases: Semantic Versioning

The project follows [Semantic Versioning 2.0.0](https://semver.org/) (`MAJOR.MINOR.PATCH`).

- **Every change that ships behavior bumps the version** in the same commit or PR, in
  `package.json` and both root `"version"` fields of `package-lock.json`. Update them together
  with `npm version <x.y.z> --no-git-tag-version`.
- Which part to bump:
  - **MAJOR** — anything that breaks an existing user or client: a removed or renamed model ID
    pattern, endpoint, request/response field, header or env var; changed defaults that alter
    results (e.g. port, bind address, advertised context windows going up); a raised minimum
    Node.js version; any change to the plugin interface above.
  - **MINOR** — backwards-compatible features: new endpoints, request fields, model variants,
    env vars.
  - **PATCH** — backwards-compatible fixes, and dependency updates without behavior changes.
  - Docs-, test- or CI-only changes don't need a bump.
- Several changes going out together get a single bump, at the highest level among them.
- **Releases are git tags `v<version>`** on the commit that carries that version, created only
  when asked. A tag is what the plugin downloads, so never move or delete a pushed tag; fix
  forward with a new version. To ship a bridge release to Hermes users, bump `BRIDGE_VERSION` in
  the plugin repository (and the plugin's own version) after the tag is pushed.

## Testing

- `npm test` runs `acceptance.test.mjs` and `multi-session.test.mjs` against the **live** Copilot
  service. They need a signed-in Copilot CLI and use real quota, which is why CI only runs
  `npm ci` and `node --check`.
- The `multi-session.test.mjs` oversize-prompt check (expects a 400 for ~260k tokens to `auto`)
  currently fails because `auto` accepts that prompt; it fails the same way on code that predates it.
- Run the tests relevant to a change before committing, and report failures plainly.

## Conventions and constraints

- The bridge binds `127.0.0.1` only. Keep it that way; it serves an unauthenticated local API by default.
- Advertised context windows (`context_length`) must never exceed what Copilot enforces at
  runtime; when the catalog can't say, advertise the lower bound so clients compact in time.
- Model catalog facts (tiers, budgets, Fusion tiers) come from the live Copilot catalog; don't
  hard-code model IDs in `server.mjs`.
- User-facing behavior changes update `README.md` in the same change.

## Commits

- Imperative, descriptive subject line; body explaining why when it isn't obvious.
- Commit or push only when asked.
