# Deploying OpenEMR to Railway

Railway runs this as **two separate services** in one project (a managed MySQL plugin + the
`openemr/openemr:flex` image), wired together with Railway's variable references, rather than
executing `docker-compose.yml` directly — Railway doesn't run multi-service Compose files
natively. `docker-compose.yml` in this directory documents the same topology for local/manual
reference.

## Steps (run once `railway login` succeeds)

```bash
cd docker/deploy
railway init                     # creates a new Railway project, prompts for a name
railway add --database mysql     # provisions a managed MySQL instance as a service
```

Then add the OpenEMR service itself (from the dashboard is simplest: **New Service → Deploy a
Docker Image → `openemr/openemr:flex`**), and set its environment variables using Railway's
variable-reference syntax so it never duplicates the MySQL credentials:

```
MYSQL_HOST=${{MySQL.MYSQLHOST}}
MYSQL_ROOT_PASS=${{MySQL.MYSQL_ROOT_PASSWORD}}
MYSQL_USER=openemr
MYSQL_PASS=<set your own strong password>
OE_USER=admin
OE_PASS=<set your own strong password — NOT the OpenEMR default>
OPENEMR_SETTING_rest_api=1
OPENEMR_SETTING_rest_fhir_api=1
OPENEMR_SETTING_rest_system_scopes_api=1
OPENEMR_SETTING_oauth_password_grant=3
OPENEMR_SETTING_site_addr_oath=https://<your-railway-domain>.up.railway.app
```

(Exact Railway MySQL plugin variable names — `MYSQLHOST` vs `MYSQL_HOST`, etc. — should be
confirmed against what `railway variables` actually prints for the MySQL service once it's
provisioned; adjust the reference above to match.)

Expose the OpenEMR service publicly (Railway → Settings → Networking → Generate Domain), which
gives you the URL for `OPENEMR_SETTING_site_addr_oath` above and for
`copilot-agent/wrangler.jsonc`'s `OPENEMR_BASE_URL`.

## After it's live

1. Update `copilot-agent/wrangler.jsonc` → `vars.OPENEMR_BASE_URL` to the Railway domain.
2. Re-run `npm run deploy` in `copilot-agent/` so the Worker points at the real instance.
3. Log into OpenEMR at the Railway URL as `admin` with the password you set, and load or
   confirm sample/demo patient data exists (never real PHI — see AUDIT.md).
4. Update this repo's root `README.md` "Deployed app URL" line with the live link (hard gate
   per the project spec — required on every submission).
