# Legal Launch Checklist

This is an operational checklist, not legal advice. Have counsel review the
public documents before launch.

## Documents

- [ ] `PRIVACY.md` and `TERMS.md` are published as public HTML pages at
      `https://waidrop.tnkrd.com/privacy` and `https://waidrop.tnkrd.com/terms`.
- [ ] `https://waidrop.tnkrd.com/privacy`, `/terms` and `/support` return HTTP
      200 without authentication.
- [ ] The Chrome Web Store privacy URL is
      `https://waidrop.tnkrd.com/privacy` and the support URL is
      `https://waidrop.tnkrd.com/support`.
- [ ] The Terms URL is linked from the store listing and popup footer, and the
      store listing includes `https://waidrop.tnkrd.com/terms`.
- [ ] The site legal pages are updated whenever `PRIVACY.md` or `TERMS.md`
      changes.
- [ ] The popup footer links to both pages.
- [ ] The documents include the contact email `waidrop@tnkrd.com` at the end.
- [ ] The legal pages identify the controller (Tomasz Habiger) and the contact
      email.
- [ ] `PRIVACY.md` and the live privacy page include the Chrome Web Store
      Limited Use statement:
      "The use of information received from Google APIs will adhere to the
      Chrome Web Store User Data Policy, including the Limited Use
      requirements."
- [ ] Review applicable contact disclosure requirements before publishing.
- [ ] If selling to Polish consumers, consider a Polish-language version of the
      key consumer information and terms.
- [ ] If actively targeting UK consumers, check whether a UK representative is
      required under UK GDPR.

## Donations

- [ ] The popup donation button points to `https://buymeacoffee.com/tomaszhabiq`.
- [ ] The donation page identifies the recipient and links its own terms/privacy
      policy.
- [ ] The popup makes clear that donations are optional and unlock nothing.
- [ ] The complaint/support process is documented and monitored.

## View-once media (build variants)

- [ ] The store submission uses the public build only: `npm run release:check:public`
      and upload `dist/waidrop-<version>-public.zip`. The personal ZIP
      (`dist/waidrop-<version>.zip`) contains view-once media capture and must
      never be submitted.
- [ ] `PRIVACY.md`, the store listing and `TERMS.md` state that view-once media
      is never captured, and this matches the shipped public artifact (enforced
      by `npm run verify:package:public`).

## Data protection

- [ ] The extension shows a first-run disclosure and requires affirmative
      consent before capture. The content script, background writes and uploads
      are gated on that consent.
- [ ] Support emails have a stated retention period (currently 12 months).
- [ ] The email provider is covered by appropriate data processing terms.
- [ ] If a data breach occurs, there is a process to notify users and UODO where
      required.
- [ ] The Chrome Web Store privacy disclosures match `PRIVACY.md`.

## Consumer information

- [ ] The extension has no checkout, subscription or paid tier.
- [ ] Complaints can be submitted to `waidrop@tnkrd.com` and are answered
      within the legally required period.
- [ ] The Terms explain that all Dropbox backups are encrypted, that the user
      must save the encryption key, and that lost keys cannot be recovered.
- [ ] The Terms explain that messages dated before installation stay local until
      full-history sync is enabled.
- [ ] The Terms explain that WhatsApp compatibility is not guaranteed.

## Packaging

- [ ] The Chrome Web Store upload is `dist/waidrop-<version>-public.zip` built by
      `npm run release:check:public`; the personal ZIP is never selected.
- [ ] `npm run release:check` passes and the built ZIP contains only allowlisted
      runtime files.
- [ ] The built ZIP includes Apache-2.0 `LICENSE` and `NOTICE`, and the popup
      identifies the project as open source.
- [ ] The built ZIP contains no payment-provider code or vendor notices.
- [ ] The donation URL is present in the popup and uses `rel="noopener"`.
