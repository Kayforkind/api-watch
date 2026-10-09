# api-watch

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
api-watch init <name> <url> [--out contracts.json]
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

## Run it in CI

`.github/workflows/api-watch.yml` runs the check every morning and uploads the report as an artifact. The job fails only on breaking changes by default.

## What it does not do

- It checks the **top-level** shape of JSON responses. It does not validate nested objects, formats, or ranges.
- Rename hints are heuristics (same type, not in the contract). A human should confirm them.
- It sends no credentials. For private APIs, point it at a gateway or proxy that adds auth on your side.

## Development

```bash
npm test
```

Tests run against a local fixture server, so they need no network access.

## License

MIT
