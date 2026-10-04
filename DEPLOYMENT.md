# Free deployment: Vercel dashboard + OCI Always Free worker

The WhatsApp Web client needs a continuously running process and persistent storage for its login profile and SQLite database. Vercel Functions and free Render services do not provide that combination. The no-monthly-bill cloud layout is:

- `dashboard/`: static dashboard and protected API proxy, deployed to Vercel Hobby.
- Repository root: Docker worker, deployed to the existing Oracle Cloud Infrastructure (OCI) Always Free VM using the GitHub Actions SSH workflow.

This keeps the worker on OCI. Moving it to another hosted cloud and retaining an always-on process plus durable disk for $0 is not a reliable option. OCI Always Free capacity depends on region and availability; verify the running VM and attached storage are within the current Always Free limits. The account may require payment details, and OCI may reclaim eligible idle compute instances. See [OCI Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## One-time OCI worker setup

The existing OCI VM must have Docker and the Docker Compose plugin installed, Git access to this repo, and an SSH user/key pair already configured as GitHub Actions secrets. On the VM, check out the repository at `~/wa-summary-bot`, create `/data`, and ensure the SSH user can run Docker and write the deployment directory. Preserve `/data` across container replacements; it contains WhatsApp LocalAuth credentials and message history.

Configure these repository Actions secrets in GitHub:

- `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `SSH_PORT`
- `GEMINI_API_KEY`, `TARGET_GROUP_NAME`, `MY_NUMBER`
- `SUMMARY_HOUR`, `SUMMARY_MINUTE`, `SUMMARY_TIMEZONE`
- `WORKER_API_TOKEN`: a long random secret shared with the Vercel project

The workflow deploys on pushes to `main` and can also be run manually. It writes the worker environment file on the VM with restrictive permissions and rebuilds the Docker Compose service. Do not expose the worker API port directly to the public internet; allow access only as needed for Vercel and health monitoring. The API itself requires the bearer token, except for minimal `/health`.

## Deploy the dashboard to Vercel Hobby

1. Import this GitHub repository into Vercel and set the project's Root Directory to `dashboard`.
2. Add Production environment variables:
   - `WORKER_URL`: public HTTPS base URL of the OCI worker, without a trailing slash.
   - `WORKER_API_TOKEN`: the same value as the GitHub Actions secret.
   - `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`: dashboard login credentials.
3. Disable Preview deployments or configure them to use a separate worker and token. Preview environments should not reach production WhatsApp data.
4. Deploy the project and verify dashboard login, QR display, status, sync, and summary actions.

The Vercel proxy keeps the worker token server-side. The dashboard uses HTTP Basic Auth. Vercel Hobby's free quota and terms can change; review [Vercel pricing](https://vercel.com/pricing).

## WhatsApp linking and persistence

Start only one worker for a WhatsApp session. Open the dashboard after the worker starts and scan its QR code once. The session profile and SQLite database live under `/data` and survive container rebuilds as long as the OCI volume is preserved. Keep the OCI instance and its boot/block volumes within Always Free quotas.

If the existing OCI worker is already connected, retain its `/data` volume and do not scan again. A deploy stops and replaces the container but reuses `/data`. Back up `/data` before any VM or storage migration.

## Local development

Run the worker with its environment variables and persistent `DATA_DIR`. For the dashboard, set `WORKER_URL`, `WORKER_API_TOKEN`, `DASHBOARD_USERNAME`, and `DASHBOARD_PASSWORD`, then run Vercel CLI from `dashboard/`.

## Current limitations

- The worker remains on OCI; this is the only identified cloud option that can run the required persistent worker at no monthly compute charge.
- OCI Always Free has regional capacity constraints and idle-instance reclamation conditions. It is not a guaranteed uptime service.
- Vercel account setup, project creation, and Production environment provisioning still require a valid Vercel connection.
