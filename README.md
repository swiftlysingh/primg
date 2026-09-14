# primg

`primg` is a small screenshot uploader for coding agents. It sends one local
PNG, JPEG, or WebP file to a Cloudflare Worker, which stores the bytes in a
private R2 bucket and returns a permanent public image URL.

The pieces are intentionally small:

```text
coding agent -> primg -> Cloudflare Worker -> private R2 bucket
```

There is one upload token, no database, and no web UI. Public image URLs use
random object IDs and do not need authentication.

## Requirements

- Node.js 22+ and npm
- A Cloudflare account with Workers and R2 enabled
- `curl` and `jq` for the shell CLI
- Wrangler authentication (`npx wrangler login`)

Install dependencies and check the Worker locally with the repository scripts:

```sh
npm install
npm run typecheck
npm test
```

The `primg` file is already executable. To put it on your `PATH`:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 primg "$HOME/.local/bin/primg"
```

## Local development

Copy the local Worker secret file and choose a token for the local server:

```sh
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set PRIMG_TOKEN to a local token.
npm run dev
```

In another shell, point the CLI at Wrangler's local server. The token must
match `.dev.vars`:

```sh
export PRIMG_HOST=http://localhost:8787
export PRIMG_TOKEN=change-me
SCREENSHOT_URL=$(primg /tmp/dashboard.png)
printf '![Dashboard](%s)\n' "$SCREENSHOT_URL"
```

`.dev.vars` contains a secret and is ignored by git. Never commit it.
Wrangler keeps local R2 data under `.wrangler/state`, separately from the
production bucket. It persists across local restarts. Remove that directory
when you need a fresh local bucket.

## Deploying to Cloudflare

Create the private R2 bucket named by the Worker binding:

```sh
npx wrangler r2 bucket create primg
```

Run the checks and deploy the Worker before setting its first secret:

```sh
npm run typecheck
npm test
npx wrangler deploy
npx wrangler secret put PRIMG_TOKEN
```

Enter a long random token at the secret prompt. Wrangler stores it as a Worker
secret without writing it to the repository. Uploads fail closed until it is set.

The Worker config binds the `primg` bucket as `IMAGES`. Keep that bucket
private. The Worker is the only public read path.

After deployment, set the same production token in the shell used by the CLI:

```sh
export PRIMG_HOST=https://img.swifti.ng
export PRIMG_TOKEN='the same value entered for npx wrangler secret put PRIMG_TOKEN'
```

The Wrangler config routes `https://img.swifti.ng` to this Worker through a
top-level `routes` entry above the `[[r2_buckets]]` block:

```toml
# wrangler.toml, top-level and above [[r2_buckets]]
routes = [{ pattern = "img.swifti.ng", custom_domain = true }]
```

The route is included when you run `npx wrangler deploy`. The CLI can use its
default host, or you can set it explicitly:

```sh
export PRIMG_HOST=https://img.swifti.ng
```

See Cloudflare's [Wrangler configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/)
and [Custom Domains docs](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
for the full route and DNS requirements.

## Direct API usage

The Worker accepts one multipart field named `file` and returns JSON:

```sh
curl \
  -H "Authorization: Bearer $PRIMG_TOKEN" \
  -F "file=@/tmp/dashboard.png" \
  "${PRIMG_HOST:-https://img.swifti.ng}/upload"
```

## Agent usage

On success, `primg` writes only the image URL to stdout. Errors and diagnostics
go to stderr, so command substitution is safe:

```sh
SCREENSHOT_URL=$(primg /tmp/dashboard.png)
```

Paste the result into a GitHub pull request:

```markdown
![Dashboard](https://img.swifti.ng/f/0123456789abcdef0123456789abcdef.png)
```

The Worker accepts files up to 20 MiB. It checks image magic bytes and the
multipart MIME value, but does not decode image pixels. It stores the correct
`Content-Type` in R2 for PNG, JPEG, and WebP images. Original filenames never
appear in public URLs. URLs remain available while the Worker, domain, and R2
objects remain in place. No lifecycle deletion is configured.

If Cloudflare returns error 1010 to a custom HTTP client, its browser-signature
check blocked the request before the Worker. The curl CLI and browser user
agents passed live testing. See [Cloudflare's error 1010 guide](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/).
