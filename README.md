[![Syntax Status](https://github.com/openemr/openemr/actions/workflows/syntax.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/syntax.yml)
[![Styling Status](https://github.com/openemr/openemr/actions/workflows/styling.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/styling.yml)
[![Testing Status](https://github.com/openemr/openemr/actions/workflows/test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/test.yml)
[![JS Unit Testing Status](https://github.com/openemr/openemr/actions/workflows/js-test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/js-test.yml)
[![PHPStan](https://github.com/openemr/openemr/actions/workflows/phpstan.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/phpstan.yml)
[![Rector](https://github.com/openemr/openemr/actions/workflows/rector.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/rector.yml)
[![ShellCheck](https://github.com/openemr/openemr/actions/workflows/shellcheck.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/shellcheck.yml)
[![Docker Compose Linting](https://github.com/openemr/openemr/actions/workflows/docker-compose-lint.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/docker-compose-lint.yml)
[![Dockerfile Linting](https://github.com/openemr/openemr/actions/workflows/docker-lint-hadolint.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/docker-lint-hadolint.yml)
[![Isolated Tests](https://github.com/openemr/openemr/actions/workflows/isolated-tests.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/isolated-tests.yml)
[![Inferno Certification Test](https://github.com/openemr/openemr/actions/workflows/inferno-test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/inferno-test.yml)
[![Composer Checks](https://github.com/openemr/openemr/actions/workflows/composer.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/composer.yml)
[![Composer Require Checker](https://github.com/openemr/openemr/actions/workflows/composer-require-checker.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/composer-require-checker.yml)
[![API Docs Freshness Checks](https://github.com/openemr/openemr/actions/workflows/api-docs.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/api-docs.yml)
[![codecov](https://codecov.io/gh/openemr/openemr/graph/badge.svg?token=7Eu3U1Ozdq)](https://codecov.io/gh/openemr/openemr)

[![Backers on Open Collective](https://opencollective.com/openemr/backers/badge.svg)](#backers) [![Sponsors on Open Collective](https://opencollective.com/openemr/sponsors/badge.svg)](#sponsors)

# AgentForge — Clinical Co-Pilot

This fork adds a **Clinical Co-Pilot** AI agent on top of OpenEMR, built for the Gauntlet AI
"AgentForge" project (Week 1). Start here:

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the agent is built, its design decisions, and known limitations (read the summary at the top first).
- **[USERS.md](./USERS.md)** — who this is for and the specific use cases it addresses.
- **[AUDIT.md](./AUDIT.md)** — security/performance/architecture/data-quality/compliance audit of this codebase.
- **[KEY_METRICS.md](./KEY_METRICS.md)** — how we'd measure whether this is actually working.
- **[AI_COST_ANALYSIS.md](./AI_COST_ANALYSIS.md)** — cost model and scaling assumptions.
- **[copilot-agent/](./copilot-agent/)** — the agent itself (Cloudflare Worker + D1); see its own [README](./copilot-agent/README.md) for setup/run/test instructions.
- **[DEMO_NOTES.md](./DEMO_NOTES.md)** — plain-language demo video script (not a technical doc).

**Deployed app URLs:**
- Clinical Co-Pilot agent (start here): https://clinical-copilot-agent.genesysx.workers.dev
- OpenEMR (the EHR itself): https://openemr-production-8057.up.railway.app

**Setup guide:** OpenEMR itself runs via Docker Compose (`docker/deploy/docker-compose.yml` for
the public deployment; `docker/development-easy/` for local dev, see below). The agent
(`copilot-agent/`) is a separate Cloudflare Worker — see its README for `npm install` / `npm run
dev` / `npm run deploy` instructions. Full rationale for this split is in ARCHITECTURE.md.

---

## Week 1 baseline vs Week 2 additions

**Week 1 (baseline, unchanged behavior):** physician logs in with OpenEMR (OAuth2 authorization
code + PKCE), picks a patient, and asks questions answered only from that patient's OpenEMR chart,
every claim source-cited and verified. Docs: [ARCHITECTURE.md](./ARCHITECTURE.md),
[AUDIT.md](./AUDIT.md), [USERS.md](./USERS.md), [KEY_METRICS.md](./KEY_METRICS.md).

**Week 2 (multimodal evidence agent):** upload a lab PDF -> structured, cited extraction; a
supervisor routes each question to workers before answering; a pre-push eval gate blocks
regressions. Docs: [W2_ARCHITECTURE.md](./W2_ARCHITECTURE.md) (start with its status table - it
states what is built and what is not).

**Run the Week 2 flow (no guessing):**
1. Open https://clinical-copilot-agent.genesysx.workers.dev and log in with OpenEMR.
2. Pick a patient (e.g. James Chen), click *Choose File*, select
   `copilot-agent/samples/sample-lab-report.pdf`, click *Upload Lab PDF*.
3. Ask "Summarize his recent labs" or "What should I pay attention to?" - the answer cites the
   uploaded values and shows the supervisor's routing line.
4. Run the eval gate locally: `cd copilot-agent && npm install && npm run eval`.
5. Enable the push-blocking hook once per clone: `npm run hooks:install`.

**Environment (Worker `copilot-agent/`)** - vars in `wrangler.jsonc`: `OPENEMR_BASE_URL`,
`OPENEMR_API_SITE`, `OPENEMR_CLIENT_ID`, `LANGFUSE_HOST`. Secrets (`wrangler secret put`):
`OPENEMR_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
(the Langfuse pair is optional; tracing no-ops without it). D1 schema: `wrangler d1 execute
clinical-copilot-db --remote --file=./schema.sql`. The OAuth client must be registered with the
scopes in `src/oauth.ts` and enabled by an OpenEMR admin (Administration > Client Registrations).

---

# OpenEMR

[OpenEMR](https://open-emr.org) is a Free and Open Source electronic health records and medical practice management application. It features fully integrated electronic health records, practice management, scheduling, electronic billing, internationalization, free support, a vibrant community, and a whole lot more. It runs on Windows, Linux, Mac OS X, and many other platforms.

### Contributing

OpenEMR is a leader in healthcare open source software and comprises a large and diverse community of software developers, medical providers and educators with a very healthy mix of both volunteers and professionals. [Join us and learn how to start contributing today!](https://open-emr.org/wiki/index.php/FAQ#How_do_I_begin_to_volunteer_for_the_OpenEMR_project.3F)

> Already comfortable with git? Check out [CONTRIBUTING.md](CONTRIBUTING.md) for quick setup instructions and requirements for contributing to OpenEMR by resolving a bug or adding an awesome feature 😊.

### Support

Community and Professional support can be found [here](https://open-emr.org/wiki/index.php/OpenEMR_Support_Guide).

Extensive documentation and forums can be found on the [OpenEMR website](https://open-emr.org) that can help you to become more familiar about the project 📖.

### Reporting Issues and Bugs

Report these on the [Issue Tracker](https://github.com/openemr/openemr/issues). If you are unsure if it is an issue/bug, then always feel free to use the [Forum](https://community.open-emr.org/) and [Chat](https://www.open-emr.org/chat/) to discuss about the issue 🪲.

### Reporting Security Vulnerabilities

Check out [SECURITY.md](.github/SECURITY.md)

### API

Check out [API_README.md](API_README.md)

### Docker

Check out [DOCKER_README.md](DOCKER_README.md)

### FHIR

Check out [FHIR_README.md](FHIR_README.md)

### For Developers

If using OpenEMR directly from the code repository, then the following commands will build OpenEMR (Node.js version 24.* is required) :

```shell
composer install --no-dev
npm install
npm run build
composer dump-autoload -o
```

### Contributors

This project exists thanks to all the people who have contributed. [[Contribute]](CONTRIBUTING.md).
<a href="https://github.com/openemr/openemr/graphs/contributors"><img src="https://opencollective.com/openemr/contributors.svg?width=890" /></a>


### Sponsors

Thanks to our [ONC Certification Major Sponsors](https://www.open-emr.org/wiki/index.php/OpenEMR_Certification_Stage_III_Meaningful_Use#Major_sponsors)!


### License

[GNU GPL](LICENSE)
