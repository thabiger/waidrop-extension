# Test fixtures

HTML fixtures live here, used by the parser tests (`npm test`).
They are **generated** — do not edit by hand:

```sh
npm run fixtures   # rebuilds them from tools/recon/out/*.json (sanitized probe output)
```

## Rules

- Only **sanitized** output from `tools/recon/whatsapp-dom-probe.js` may be committed.
- Never commit real message text, contact names, phone numbers, or `data-id`s.
  The probe already replaces text with `«t:N»` placeholders and masks numbers/titles.

## Files

- `message-in.html` — DM incoming row (real structure, sanitized).
- `message-out.html` — DM outgoing row.
- `group-message-in.html` — group incoming row with `author` element.
- `group-system.html` — system/notification row (must be skipped by the parser).
