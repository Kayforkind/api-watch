# api-watch 0.2.2

> Contract checks with environment-backed credentials, redirects refused, bounded responses, and secret-safe reports.

**Know about the API change before your users do.**

api-watch keeps a contract for every API response your app depends on. It re-checks the live endpoints on a schedule and tells you what broke, with a rename hint when a field simply moved.

- **Snapshot a contract from reality:** `api-watch init` records the shape of a live JSON response.
- **Catch breaking changes:** missing fields, changed types, wrong status, unreachable endpoints, non-JSON responses.
- **Catch deprecations early:** `Deprecation` and `Sunset` headers, with a loud alert when a sunset is under 60 days away.
- **Rename hints:** when `email` disappears and `mail` appears with the same type, it says so. These are hints to verify, not automatic fixes.
- **CI-native:** exit codes, JSON and Markdown reports, and a ready-to-copy GitHub Action.
- **Zero dependencies.** Node 20+ only. Nothing is sent anywhere except the requests you configure.

## Quick start

```bash
node watch.mjs init users https://api.example.com/users/1 --out contracts.json
node watch.mjs check contracts.json
```

```
# API watch — 2026-10-09T12:28:37.913Z

Breaking: 0 · Warnings: 0 · Info: 0

## users (200)
- no changes
```

When a field is renamed:

```
## users (200)
- **BREAKING** missing field "email" (string); hint: "mail" (string) may be the renamed "email"
```

## Commands

```
api-watch check <contracts.json> [--json out.json] [--md out.md]
                [--timeout 10000] [--fail-on breaking|warning]
api-watch init <name> <url> [--out contracts.json] [--header "Name: ${ENV_VAR}"]...
```

| Exit | Meaning |
| --- | --- |
| `0` | Clean (or only warnings, unless `--fail-on warning`) |
| `1` | Breaking change found |
| `2` | Bad input or usage error |

## Contract format

```json
[
  {
    "name": "users",
    "url": "https://api.example.com/users/1",
    "expect": {
      "status": 200,
      "fields": { "id": "number", "email": "string" }
    }
  }
]
```

Set `"array": true` when the response is a list. Fields are then checked against the first element.

### Private APIs

Add `"headers"` with `${ENV_VAR}` placeholders. The value is read from the environment when you run the check, so the secret never lives in `contracts.json`:

```json
{
  "name": "me",
  "url": "https://api.example.com/me",
  "headers": { "Authorization": "Bearer ${API_TOKEN}" },
  "expect": { "status": 200, "fields": { "id": "number" } }
}
```

```bash
API_TOKEN=... node watch.mjs check contracts.json
node watch.mjs init me https://api.example.com/me --header 'Authorization: Bearer ${API_TOKEN}'
```

- If a variable is unset or empty, the check reports it as BREAKING and sends no request.
- `init` refuses to save a literal value for credential headers (`Authorization`, `Cookie`, names containing `token`, `secret`, `key`). Use `${ENV_VAR}` instead.
- Reports include the contract name, URL, status, and findings. They never include header values.

## Run it in CI

`.github/workflows/api-watch.yml` runs the check every morning and uploads the report as an artifact. The job fails only on breaking changes by default. For private APIs, pass credentials from repository secrets as environment variables, for example `env: { API_TOKEN: ${{ secrets.API_TOKEN }} }` on the check step.

## Security boundaries

- Contracts are trusted network configuration: requests may target private or loopback services. Do not offer this CLI as a public URL-fetching service without a separate SSRF/DNS/network-egress policy.
- Redirects are refused so custom credential headers cannot follow a redirect to another origin. Credentials require HTTPS, except loopback development fixtures.
- Credential headers accept only an entire `${VAR}` placeholder, optionally prefixed with `Bearer ` or `Basic `. Literal credentials, embedded URL credentials, credential query parameters and header control characters are refused. Arbitrary secrets disguised under unrelated names cannot be detected.
- Response bodies are limited to 2 MiB and the timeout covers reading the body. Contract arrays must contain 1–100 valid, uniquely named entries; invalid configurations fail before network access.
- Report paths cannot overwrite the contract input or each other. Markdown escapes remote HTML/control characters. Store reports privately: URLs and field names may still be sensitive.

## What it does not do

- It checks the **top-level** shape of JSON responses. It does not validate nested objects, formats, or ranges.
- Rename hints are heuristics (same type, not in the contract). A human should confirm them.
- It sends only the headers you list in a contract. It does not log in, refresh tokens, or handle OAuth flows. For those, put a token in an environment variable and reference it.

## Development

```bash
npm test
```

Tests run against a local fixture server, so they need no network access.

## License

MIT

## Release verification

Use a supported Node LTS (22 or 24). Run `npm ci --ignore-scripts` followed by `npm run verify`. The security workflow runs the regression suite on Linux and Windows; it has not yet been executed remotely for this local change. New report/output files are created exclusively; choose fresh filenames or output folders for repeat runs. See [SECURITY.md](SECURITY.md) for the threat model and disclosure guidance.
