# WAiDrop Manual Test Plan

Manual end-to-end test plan for the WAiDrop Chrome extension and the
`waidrop-cli` companion. The goal is to verify that a user can capture chats
in the extension, back them up to Dropbox, and read the same archive with the
CLI installed from PyPI.

## 1. Purpose and scope

In scope:

- Extension capture, Dropbox backup, media, full-history sync and offload.
- CLI installed the way an end user installs it: `pip install waidrop-cli`
  and `uv tool install waidrop-cli` from PyPI.
- CLI connection to the Dropbox archive, plaintext and encrypted reads, chat
  selection, time-window queries, context output and media export.
- The full handoff: extension writes the archive, CLI reads it.

Out of scope:

- Feeding CLI output to an AI tool or evaluating AI answers.
- Automated cross-repository contract tests. This document is manual only.
- The personal extension build and view-once capture. Use the public build
  (the artifact you will submit) for this pass.
- WhatsApp terms, payment-provider compliance and Chrome Web Store review.

## 2. Artifacts under test

| Artifact | Source | Notes |
|---|---|---|
| Extension ZIP | `dist/waidrop-<version>-public.zip` | Public build only. Load unpacked from an extracted directory. |
| CLI package | PyPI `waidrop-cli` | Installed with pip and uv in clean environments. |
| Dropbox app | Development or production app | Same app key for extension and CLI. App Folder access. |
| Buy Me a Coffee | Public page | Optional donation link smoke check only. |

Before testing, confirm:

- [ ] `npm test` passes.
- [ ] `npm run release:check:public` passes.
- [ ] The public ZIP contains no view-once UI or capture code.
- [ ] The CLI version installed from PyPI is the version under test.
- [ ] `background/config.js` and the CLI both use the same Dropbox app key.

## 3. Test environment

### 3.1 Extension build

1. Build the public package:

   ```sh
   npm run release:check:public
   ```

2. Extract the ZIP to a temporary directory and load it with **Load unpacked**
   in `chrome://extensions`.
3. Note the extension ID. The public build does not display the redirect URI;
   use `https://<extension-id>.chromiumapp.org/`. The personal build shows it
   under **Storage - Dropbox backup**.
4. Confirm the Dropbox app console has that exact redirect URI registered.

### 3.2 CLI install, as an end user

Run these from a directory outside the CLI repository, for example `cd ~`, so a
local source checkout cannot mask installation problems.

Prefer `WAIDROP_KEY` and the credentials file over `--key`, `--code` and
`--dropbox-token`. Command-line secrets can appear in shell history and process
listings.

**pip path (primary):**

```sh
python3 -m venv ~/wd-manual-pip
source ~/wd-manual-pip/bin/activate
python -m pip install --upgrade pip
pip install waidrop-cli
which waidrop
waidrop --version
waidrop --help
pip show waidrop-cli
```

**uv path (separate isolated install):**

```sh
uv tool install waidrop-cli
uvx waidrop --version
uv tool list
```

**Upgrade and uninstall path:**

```sh
# pip path
pip install --upgrade waidrop-cli
pip uninstall waidrop-cli

# uv path
uv tool upgrade waidrop-cli
uv tool uninstall waidrop-cli
```

Expected:

- [ ] `waidrop` resolves to the installed entry point, not a repository script.
- [ ] `waidrop --version` prints the published version.
- [ ] `waidrop --help` lists `auth`, `config`, `chats`, `query` and `context`.
- [ ] Installing and running do not require the CLI source repository.
- [ ] After uninstall, the command is gone; reinstalling restores it.

### 3.3 Dropbox app

The Dropbox app must be the same app for extension and CLI, because App Folders
are namespaced per app key.

- [ ] App has **App folder** access.
- [ ] These scopes are enabled and submitted:
  - `account_info.read`
  - `files.metadata.read`
  - `files.content.read`
  - `files.content.write`
- [ ] Extension redirect URI is registered.
- [ ] After enabling scopes, existing connections are reconnected (Disconnect →
      Connect); tokens do not gain new scopes retroactively.
- [ ] A fresh Connect shows the account name/email (not a `dbid:` id) and
      Test Connection passes.
- [ ] Test accounts are added if the app is still in development mode.
- [ ] The built-in app key in `background/config.js` matches the CLI's default
      app key.
- [ ] To test with a different app key, change `DEFAULT_DROPBOX_APP_KEY` in
      `background/config.js` and rebuild (the extension UI has no key field);
      the CLI accepts `--dropbox-app-key`.

### 3.4 Browser profiles and accounts

Use dedicated test accounts and a disposable Dropbox App Folder. Some checks
delete remote objects, revoke tokens, remove scopes or switch accounts; never
run them against a production archive.

- [ ] Profile A: primary test profile, public extension build, WhatsApp account A.
- [ ] Profile B: second Chrome profile for multi-account tests.
- [ ] WhatsApp test group with at least two other participants.
- [ ] One 1:1 contact for direct-chat tests.
- [ ] Two Dropbox test accounts if testing account switching.
- [ ] Optional: a second WhatsApp account in profile B for alias tests.

### 3.5 Feature access

There is no entitlement, purchase or restore flow. A fresh install has every
feature enabled: all chats, startup catch-up, full-resolution media, full-history
sync and the account alias setting. The popup shows one optional **Buy me a
coffee** link that opens `https://buymeacoffee.com/tomaszhabiq`.

## 4. Test data

### 4.1 Chats

| Chat | Purpose |
|---|---|
| `WD QA Group` | Group capture, media, offload |
| `WD QA Direct` | 1:1 capture and media |
| A second alias account | Multi-account and `--account` tests |

### 4.2 Messages

Send these in the group and in the 1:1 chat:

- text in both directions
- emoji, URL, multiline text, control characters
- reply/quote
- edit and delete-for-everyone
- image with caption
- video
- voice note
- document (PDF)
- sticker
- GIF
- location
- contact card
- group system event (add/remove participant)
- one image or sticker with a known, distinctive object or text
- one message longer than `--max-chars` will use (for example 8,000 characters)
- one message starting with `=` for CSV safety
- messages just before and after local midnight, for date-boundary tests

Keep a small written record of expected facts, for example:

- "Alice: the launch is Friday."
- "Bob will send the pricing PDF by Thursday."
- "Open question: do we keep the old logo?"
- "The whiteboard image says PROJECT ORION."

You will use these facts to check that the CLI returns the correct messages,
chats, senders and timestamps. AI consumption is not part of this plan.

### 4.3 Baseline

Before uploading, record:

- [ ] Extension popup: total messages, pending upload, media counts, last sync.
- [ ] CLI `waidrop chats` output, if an archive already exists.
- [ ] Dropbox object list: names, sizes, folders.
- [ ] Whether the archive is plaintext or encrypted.
- [ ] Account alias and archive mode.

## 5. Scenario format

Each scenario lists preconditions, steps and expected results. Tick the boxes as
you go. Record failures in the results table at the end with the scenario ID,
the step and the exact observed behavior.

## 6. Scenarios

### S1. CLI install, connect and auth lifecycle

Priority: P0

Preconditions: Dropbox app configured; PyPI reachable; no CLI repository on
`PATH`.

Steps:

- [ ] Create a clean venv and `pip install waidrop-cli`.
- [ ] From `cd ~`, run `waidrop --version`, `waidrop --help`,
      `pip show waidrop-cli`.
- [ ] Install separately with `uv tool install waidrop-cli` and run
      `uvx waidrop --version`.
- [ ] Run `waidrop auth`. Complete the Dropbox authorization.
- [ ] Confirm the credentials file location:
      `~/.config/waidrop/credentials.json` on macOS/Linux, `%APPDATA%\waidrop\credentials.json`
      on Windows.
- [ ] Check permissions: credentials file `0600`, directory `0700`.
- [ ] Run `waidrop config`, paste the archive key at the hidden prompt, enter
      an account alias or press Enter for `primary`, and confirm
      `~/.config/waidrop/env` is created with `0600` and the `waidrop`
      directory is `0700`.
- [ ] Confirm `waidrop config` output includes the path and account but never
      the archive key.
- [ ] Re-run `waidrop config` with no env vars: confirm the key prompt shows
      `[keep existing]` without the key value, the account prompt shows the
      existing alias, and pressing Enter keeps both.
- [ ] Re-run and enter a new key/account; confirm both are replaced.
- [ ] Re-run with `--account work` and `--env-file <tmp>/env`; confirm only
      `WAIDROP_KEY` and `WAIDROP_ACCOUNT` are written and other entries are
      preserved.
- [ ] Run `waidrop auth --status` and `waidrop auth --status --json`.
- [ ] Confirm the JSON contains the account, app key, scopes and missing scopes,
      but no access token or refresh token.
- [ ] Run `waidrop auth --revoke`. Confirm the remote token is revoked and the
      local credentials file is removed.
- [ ] Re-run `waidrop auth` to restore access.
- [ ] Test `waidrop auth --no-browser` and `waidrop auth --loopback` if the
      loopback redirect URI is registered.
- [ ] If testing the paste flow, also try `waidrop auth --code "<CODE>"` with a
      freshly obtained authorization code.
- [ ] Test a custom credentials path with `--credentials-file` or
      `WAIDROP_CREDENTIALS`. Confirm the file is created there with `0600`.
- [ ] Test upgrading with `pip install --upgrade waidrop-cli` and
      `uv tool upgrade waidrop-cli`.
- [ ] Test uninstalling and reinstalling. Confirm existing credentials survive a
      reinstall.
- [ ] Run the CLI from a directory outside the repository and confirm it still
      works.

Expected:

- [ ] CLI installs and runs without the repo checkout.
- [ ] Auth completes and stores a refresh token with private permissions.
- [ ] `--status` exits `0` when scopes are complete.
- [ ] Missing scopes exit `2` with an actionable message.
- [ ] `--revoke` deletes local credentials only after a successful remote revoke.
- [ ] No token or archive key is printed in status output.
- [ ] The PyPI-installed command and the uv-installed command behave the same.

Failure signs: command not found; a repository path is required; credentials are
world-readable; tokens appear in output; missing-scope errors do not name the
missing scopes.

### S2. End-to-end: all chats, encrypted backup, CLI read

Priority: P0

Preconditions: Fresh profile, public build, Dropbox app, CLI authenticated from
S1, test group and 1:1 chat ready.

Steps:

- [ ] Open the popup before WhatsApp. Confirm:
  - [ ] No plan badge or upgrade/purchase controls are present.
  - [ ] The **Buy me a coffee** button links to `https://buymeacoffee.com/tomaszhabiq`.
  - [ ] Alias is editable.
  - [ ] Media mode defaults to **Passive**.
  - [ ] Encryption key is present and the key controls are enabled.
  - [ ] The pre-install sync checkbox is enabled and unchecked.
- [ ] Copy the encryption key, store it safely, and check the key-acknowledgment
      checkbox.
- [ ] Open WhatsApp Web, log in, open `WD QA Group`, and send the test messages.
- [ ] Open `WD QA Direct` and send text and media.
- [ ] In **Storage - Dropbox backup**, connect Dropbox.
- [ ] Save settings with uploads enabled, then click **Upload now**.
- [ ] Inspect the Dropbox App Folder.
- [ ] From `cd ~`, run with the archive key:

  ```sh
  WAIDROP_KEY="<key>" waidrop chats --account primary
  WAIDROP_KEY="<key>" waidrop query --name "WD QA Group" --last 24h --format ndjson --out qa-group.ndjson
  WAIDROP_KEY="<key>" waidrop query --name "WD QA Group" --last 24h --format text
  WAIDROP_KEY="<key>" waidrop query --name "WD QA Group" --last 24h --media-out ./qa-media-group
  ```

- [ ] Send more than 300 messages and upload again.
- [ ] Send a message dated before installation (or use a fixture).

Expected:

- [ ] Dropbox contains `/account=primary/_format.json` with encrypted mode,
      `_chats/index.enc`, chat maps and `.enc` message parts.
- [ ] No plaintext message objects are present.
- [ ] Both group and 1:1 chat objects are present.
- [ ] `waidrop chats` lists both `WD QA Group` and `WD QA Direct`.
- [ ] CLI requires the key and does not print a plaintext warning.
- [ ] Query records match the extension archive.
- [ ] Uploads are not capped: all pending messages upload in one run.
- [ ] Pre-install messages stay local until full-history sync is enabled.
- [ ] The key is never printed and never appears in Dropbox.

Failure signs: plaintext objects in Dropbox; a missing 1:1 record; a message
upload cap; pre-install messages uploaded without the setting; the key in logs
or output.

### S3. Media end-to-end: 1:1 chats and media

Priority: P0

Preconditions: An encrypted `primary` archive exists (from S2); CLI connected.

Steps:

- [ ] Reopen the popup. Confirm the alias/key/encryption/media controls are
      enabled.
- [ ] Set media mode to **Passive** and click **Save settings**.
- [ ] Send 1:1 text, images, stickers, GIFs, video, voice note and a document.
      Open some media but not all.
- [ ] Send new group media as well.
- [ ] Click **Upload now**.
- [ ] Run:

  ```sh
  waidrop chats
  waidrop query --name "WD QA Direct" --last 24h --format ndjson --out qa-direct.ndjson
  waidrop query --number "<phone>" --last 24h
  waidrop query --chat "<hash>" --last 24h
  waidrop query --jid "<jid>" --last 24h
  waidrop query --name "WD QA Group" --number "<phone>" --last 24h
  waidrop context --name "*WD QA*" --last 24h --context-before 30m \
    --max-chars 6000 --format ndjson \
    --media-out ./qa-media --out qa-context.ndjson
  ```

- [ ] Inspect `./qa-media` and `manifest.ndjson`.
- [ ] Open each exported image/sticker/GIF and compare it with the source.
- [ ] Set media mode to **Active**, click **Save settings**, send unopened media, and confirm capture.
- [ ] Switch Active back to Passive, click **Save settings**, and send more media.
- [ ] Set the media size limit to 1 MB, click **Save settings**, and send a larger file.
- [ ] Run a query with `--media-max-bytes` below the size of one exported file.
- [ ] Edit one message and delete another for everyone. Upload and rerun a query.

Expected:

- [ ] `waidrop chats` now lists both group and 1:1 chats.
- [ ] Selectors by name, number, chat hash and JID resolve to the right chats.
- [ ] 1:1 records are present in the CLI output.
- [ ] Images, stickers and GIFs have `media.status = "stored"` and export as
      files that open correctly.
- [ ] `manifest.ndjson` maps each file to `msgId`, chat, sender, timestamp,
      status and error.
- [ ] Video, audio and documents remain placeholders and are reported as
      skipped/not exported, not as fake files.
- [ ] Active mode captures new unopened media; Passive does not make WhatsApp
      media requests.
- [ ] A file above the extension limit is not captured; a file above
      `--media-max-bytes` is skipped by the CLI with a clear status.
- [ ] Edits and revokes appear in the latest query, not as duplicates.
- [ ] CLI results match the captured test data; spot-check a few of the same
      messages in the popup recent list.

Failure signs: a 1:1 chat missing; an exported file that does not open; media
status `stored` with no object; video/audio/document exported as fake images;
duplicate records after an edit.

### S4. Encrypted archive end-to-end: key handling and decryption

Priority: P0

Preconditions: An encrypted `primary` archive exists; CLI connected; Dropbox
available.

Steps:

- [ ] Confirm the archive is encrypted and the key is locked after local data
      exists.
- [ ] Try to save with uploads enabled but without acknowledging the key or with
      an invalid key. Confirm the save is refused.
- [ ] Copy the key, store it safely, acknowledge the key, and save.
- [ ] Click **Upload now**.
- [ ] Inspect the Dropbox App Folder.
- [ ] From `cd ~`, run:

  ```sh
  waidrop chats --account primary
  waidrop chats --account primary --key "<wrong-key>"
  WAIDROP_KEY="<right-key>" waidrop chats --account primary
  WAIDROP_KEY="<right-key>" waidrop query --account primary --last 24h --format ndjson     --out qa-encrypted.ndjson
  WAIDROP_KEY="<right-key>" waidrop context --account primary --last 24h     --context-before 30m --format text
  WAIDROP_KEY="<right-key>" waidrop context --account primary --last 24h     --media-out ./qa-media-enc --format ndjson --out qa-media-enc.ndjson
  ```

- [ ] Open the decrypted media files.
- [ ] Search CLI output and Dropbox objects for the key. Confirm it is absent.
- [ ] Try an invalid key string and a truncated key.

Expected:

- [ ] Encrypted archive uses `_format.json` with encrypted mode and `.enc`
      objects. Dropbox cannot read chat names, text, phone numbers, message IDs
      or media.
- [ ] CLI without a key exits `2` with "archive is encrypted; encryption key
      required".
- [ ] Wrong key exits with the documented archive/Dropbox read error and reveals
      no plaintext.
- [ ] Correct key lists chats and returns messages/media identical to the
      extension archive.
- [ ] Both `--key` and `WAIDROP_KEY` work.
- [ ] Invalid keys fail cleanly without modifying the archive.
- [ ] Encrypted media decrypts and opens.
- [ ] `--account primary` selects the primary encrypted archive; other aliases
      remain independent.
- [ ] The key is never printed and never appears in Dropbox.

Failure signs: plaintext data in `.enc` objects; wrong-key output containing
message text; CLI ignoring `--account`; key in logs or output.

### S5. Full-history sync and alias changes

Priority: P0

Preconditions: A fresh profile with an encrypted archive captured before the
install date (fixture or historical messages) and CLI access. Perform S5 as one
continuous path in the same profile.

Steps:

- [ ] Record the baseline: extension message count, pending count,
      `waidrop chats`, `waidrop query --last 24h` record count.
- [ ] Send more than 300 messages and upload. Confirm there is no daily cap.
- [ ] Confirm pre-install messages are kept locally but not uploaded.
- [ ] Enable **Sync messages dated before installation**, save, and confirm older
      local messages are requeued and uploaded.
- [ ] Run `waidrop chats --account primary` and a 1:1 query with the key.
- [ ] Change the account alias, save, and upload. Confirm new objects land under
      `/account=<alias>/`.
- [ ] Rerun the CLI with `--account <alias>`.
- [ ] Switch the alias back to `primary` and confirm SQL/CLI continuity.

Expected:

- [ ] Uploads are not capped; the backlog drains in one run.
- [ ] Pre-install messages sync only after the checkbox is enabled.
- [ ] Changing the alias re-targets uploads without mixing archives.
- [ ] No CLI output mixes records from different aliases.
- [ ] Local and remote data are never deleted by these operations.

Failure signs: a daily upload cap; pre-install messages synced without the
setting; mixed-alias output; lost offloaded history; CLI unable to read the
archive.

### S6. Offload, local Clear and media repair: CLI continuity

Priority: P0

Preconditions: An archive uploaded to Dropbox; CLI authenticated.

Steps:

- [ ] Upload group text messages.
- [ ] Set offload retention to `0` and click **Run cleanup now**.
- [ ] Confirm the popup shows archived stubs.
- [ ] Run `waidrop query --name "WD QA Group" --last 24h --format ndjson`.
      Confirm full text is returned.
- [ ] Capture and upload media, then offload. Confirm local media bytes are
      removed.
- [ ] Run `waidrop context --name "WD QA Group" --last 24h --media-out ./qa-media-offload`
      and confirm the media still exports.
- [ ] Clear the local archive with **Clear**. Confirm Dropbox objects remain.
- [ ] Run the same CLI query again. Confirm the remote archive is still fully
      readable.
- [ ] Send a new group message, upload, and query again.
- [ ] Test late media: offload text before media arrives, then let media arrive,
      run **Repair media**, and query/export again.
- [ ] Change the encryption key, alias or Dropbox account while offloaded
      messages exist. Confirm the extension pauses or blocks upload and offload.
- [ ] With the original key/alias/account, confirm the CLI still reads the old
      archive.

Expected:

- [ ] Offload clears only the local payload; the CLI still reads the full
      message from Dropbox.
- [ ] Offloaded media remains exportable through the CLI.
- [ ] Clearing local data does not delete Dropbox data; the CLI still reads the
      archive.
- [ ] New messages after Clear appear in the CLI without duplicates of old ones.
- [ ] Media repair makes late media visible to the CLI and `mediaExport`
      reflects `exported` or the correct skipped status.
- [ ] Changing destination/key is blocked or paused by the extension and does
      not corrupt the old archive.
- [ ] The CLI has no stale cache: every query reflects the latest upload.

Failure signs: CLI returning `[archived in Dropbox]` or empty text for offloaded
records; media export failing after local offload; old records disappearing
after Clear; duplicates after a re-upload.

### S7. Multiple accounts

Priority: P1

Preconditions: Two Chrome profiles, two WhatsApp accounts if available, Dropbox
app access; CLI installed.

Steps:

- [ ] In profile A, set alias `account-a`, click **Save settings**, and upload.
- [ ] In profile B, set alias `account-b`, click **Save settings**, and upload.
- [ ] Run:

  ```sh
  waidrop chats --account account-a
  waidrop chats --account account-b
  ```

- [ ] Install the CLI in a fresh environment and authenticate with the same
      Dropbox app. Read the archive with the correct account and key.
- [ ] Test the same alias in two profiles and record the result. This is
      unsupported; confirm the documentation/warning is visible and the CLI
      shows the merged archive.
- [ ] Run `waidrop auth --revoke` and verify the extension still uploads.
      Re-authenticate the CLI.
- [ ] If a second Dropbox account is available, connect the extension to it and
      verify archive isolation.

Expected:

- [ ] `--account` isolates `account-a` and `account-b` completely.
- [ ] The CLI reads each archive with the saved key.
- [ ] Same-alias merging is visible and treated as unsupported.
- [ ] CLI revoke does not break extension uploads.
- [ ] Different Dropbox accounts have separate archives and credentials.

Failure signs: cross-account records; CLI silently uses the default key after a
custom key; revoking the CLI breaks the extension.

### S8. CLI contract, edge cases and errors

Priority: P1

Preconditions: At least one encrypted archive; CLI installed from PyPI; known
test data.

#### Selectors

- [ ] `waidrop chats --name "WD*"` matches the expected chats.
- [ ] `--name` substring and glob matching are case-insensitive.
- [ ] `--number` works with formatted and unformatted phone numbers.
- [ ] `--chat "<hash>"` and `--jid "<jid>"` select the same chat.
- [ ] Multiple `--name`/`--number` selectors are combined.
- [ ] An unknown selector exits `3` with "no chats matched".
- [ ] If a LID chat is available, it can be selected by name even though it has
      no phone number.
- [ ] No selectors means all chats.

#### Time windows

- [ ] Date precision: `--from YYYY-MM-DD --to YYYY-MM-DD` includes the whole
      `to` day.
- [ ] Hour precision: `--from YYYY-MM-DDTHH --to YYYY-MM-DDTHH` includes the
      whole end hour.
- [ ] Minute and second precision work.
- [ ] `--last 90m`, `--last 36h`, `--last 7d`, `--last 2w` work.
- [ ] `--last` combined with `--from`/`--to` is rejected with exit `2`.
- [ ] A message exactly at the start boundary is included; a message exactly at
      the end boundary is excluded.
- [ ] Messages captured around local midnight still appear when queried with
      the browser's timezone and with `--tz`.
- [ ] An unknown timezone exits `2`.

#### Output

- [ ] NDJSON output parses line by line.
- [ ] Text output escapes newlines, tabs, backslashes and control characters.
- [ ] A message beginning with `=`, `+`, `-`, `@`, tab or carriage return is
      prefixed with `'` in CSV.
- [ ] `--out FILE` writes to a file with mode `0600`; progress remains on
      stderr.
- [ ] `--quiet` suppresses progress output.
- [ ] stdout contains no progress or warning text when redirecting NDJSON.

#### Media

- [ ] `stored` images/stickers/GIFs export.
- [ ] `not_downloaded`, `pending`, `view_once` and `too_large` records are
      reported as skipped, not as files.
- [ ] A media object missing from Dropbox is reported as failed.
- [ ] `--media-max-bytes` skips larger files. Use a threshold of `1` to force
      the skip.
- [ ] `--media-fail-fast` aborts on the first failure. Force a failure by
      deleting one media object from Dropbox or using a wrong key.
- [ ] A custom `--media-manifest` path is honored.
- [ ] `manifest.ndjson` is written with mode `0600`; media directory is `0700`
      and files are `0600`.
- [ ] Encrypted media exports only with the correct key.

#### Errors and exit codes

- [ ] Success exits `0`.
- [ ] Usage/config errors exit `2`: missing key, invalid bounds, invalid alias,
      invalid timezone.
- [ ] No matched chats or no messages in the window exits `3`.
- [ ] `--max-parts` guard exits `4`: use a wide window and `--max-parts 1`.
- [ ] Dropbox/network/archive read errors exit `5`. Test by disconnecting the
      network and running a query.
- [ ] Missing Dropbox scopes produce an actionable `2`. Remove one scope in the
      Dropbox app console, re-authorize, and run a query.
- [ ] Revoked refresh token produces an actionable re-auth message. Revoke app
      access in the Dropbox account settings, then run a query with the old
      credentials.
- [ ] Empty archive: connect the extension to a fresh Dropbox folder, upload once
      with no messages, then run `waidrop chats`. Expect exit `3` and a clear
      "chat directory is empty" message.
- [ ] Wrong `--account` or wrong app key: record the actual behavior. If the CLI
      reports "archive is encrypted; encryption key required" when the real
      problem is a missing archive, note it as a UX issue and include the exact
      message.
- [ ] No stack traces are printed for expected errors.

#### Data correctness

- [ ] Duplicate deliveries produce one record.
- [ ] Edited and revoked messages appear in their latest state.
- [ ] Offloaded records are still readable from Dropbox.
- [ ] DOM-only records without a `chatId` are grouped by chat name.
- [ ] `chats` shows the latest chat name after a rename.
- [ ] Records from different parts are deduplicated and ordered by timestamp.

### S9. Packaging and version compatibility

Priority: P1

Preconditions: Final candidate extension ZIP and PyPI CLI release.

Steps:

- [ ] Load the public extension ZIP and repeat the smoke path from S2.
- [ ] Confirm the public ZIP has no view-once UI or capture strings.
- [ ] Install the CLI from PyPI in a clean environment; do not use `uv run` from
      the source repo as the primary path.
- [ ] Confirm versions:
  - [ ] Extension manifest version.
  - [ ] `waidrop --version`.
  - [ ] Archive format version in `_format.json`.
- [ ] Confirm the CLI can read an archive created by this exact extension build.
- [ ] Confirm `pip install --upgrade waidrop-cli` and
      `uv tool upgrade waidrop-cli` work.
- [ ] Confirm the Dropbox app is in the intended production/development state
      and all four scopes are approved.
- [ ] Confirm the popup's Buy Me a Coffee link points to
      `https://buymeacoffee.com/tomaszhabiq` and opens a new tab.

Expected:

- [ ] The built artifacts, not just the source trees, pass the end-to-end path.
- [ ] Version and format numbers are compatible.
- [ ] The CLI installed from PyPI reads the current extension archive.

### S10. Startup catch-up after the tab was closed

Priority: P1

Preconditions: A logged-in WhatsApp Web profile with the extension loaded and a
group chat available.

Steps:

- [ ] Close the WhatsApp Web tab (not just the window).
- [ ] From another device, send several group messages, then read them on the
      phone so they are no longer unread.
- [ ] Reopen WhatsApp Web and leave it on a different chat.
- [ ] Wait ~30 seconds without opening the chat that received the messages.
- [ ] Check the popup/activity log or run `waidrop query --name "<group>"
      --last 1h` after an upload.
- [ ] Send an image in the same window, open it on the phone so WhatsApp caches
      it, then close/reopen the tab and repeat.
- [ ] Open DevTools Network, filter `web.whatsapp.com`, and watch during the
      reopen.

Expected:

- [ ] Messages received while the tab was closed appear in the archive after the
      reopen, even though their chat was never opened.
- [ ] The catch-up is bounded (at most 5,000 records per page load) and does not
      duplicate records already archived.
- [ ] Pre-install catch-up records upload only when **Sync messages dated before
      installation** is enabled.
- [ ] Passive mode captures cached catch-up media; Active mode makes no media
      download during catch-up.
- [ ] No new WhatsApp history, media or other network requests appear in DevTools
      as a result of catch-up.

Failure signs: duplicate archive rows; loader/history requests in DevTools;
Active mode downloading old media during catch-up; pre-install catch-up records
uploaded without the setting.

## 7. Execution order

Run in this order to reuse state and exercise the conversion path:

1. S1: CLI install and auth.
2. S2: End-to-end on a fresh profile.
3. S5: Full-history and alias path in the same profile as S2.
4. S3: Detailed media checks.
5. S4: Detailed encryption checks. Reuse the encrypted `primary` archive from S2
   or S5.
6. S6: Offload, Clear and repair.
7. S7: Multi-account in a second profile.
8. S8: CLI contract and errors.
9. S9: Packaging and version compatibility.
10. S10: Startup catch-up after the tab was closed.

S2 and S5 are the most important scenarios. Do not skip them or reset the
profile between their steps; the archive, pre-install history and alias changes
are the paths most likely to break. S3 and S4 are deeper checks that can be run
on the same profile or separately.

If time is short, the minimum release gate is S1, S2, S5, S4, S6 and S9. Those
cover install/auth, capture, full-history/alias behavior, encryption,
offload/CLI continuity and the packaged artifacts.

## 8. Results table

| ID | Scenario | Profile/build | Result | Notes |
|---|---|---|---|---|
| S1 | CLI install/auth | | | |
| S2 | End-to-end | | | |
| S3 | Media | | | |
| S4 | Encrypted | | | |
| S5 | Full history/alias | | | |
| S6 | Offload/clear/repair | | | |
| S7 | Multi-account | | | |
| S8 | CLI contract/errors | | | |
| S9 | Packaging/version | | | |

For each failure, record:

- scenario and step number
- expected vs actual
- extension console or service-worker errors
- CLI command, stderr, exit code
- whether it reproduces after a fresh extension/CLI install

## 9. CLI quick reference

```sh
# Install as an end user
pip install waidrop-cli
uv tool install waidrop-cli

# Auth
waidrop auth
waidrop auth --status
waidrop auth --status --json
waidrop auth --revoke

# Chats
waidrop chats
waidrop chats --name "*Family*"
waidrop chats --account account-b

# Query
waidrop query --name "WD QA Group" --last 24h --format ndjson
waidrop query --number "+49 170 0000000" --from 2026-11-01 --to 2026-11-02
waidrop query --chat "<hash>" --last 7d --format csv --out result.csv
waidrop query --jid "<jid>" --last 1h

# Encrypted archive
WAIDROP_KEY="<base64-key>" waidrop query --account primary --last 24h

# Context
waidrop context --name "WD QA Group" --last 6h --context-before 30m \
  --max-chars 6000 --format text

# Media
waidrop context --last 24h --media-out ./qa-media --format ndjson
waidrop query --last 24h --media-out ./qa-media --media-max-bytes 52428800
```

Environment variables:

- `WAIDROP_KEY`
- `WAIDROP_ACCOUNT`
- `WAIDROP_FOLDER`
- `WAIDROP_DROPBOX_TOKEN`
- `WAIDROP_DROPBOX_REFRESH_TOKEN`
- `WAIDROP_DROPBOX_APP_KEY`
- `WAIDROP_DROPBOX_APP_SECRET`
- `WAIDROP_CREDENTIALS`

Exit codes:

- `0` success
- `2` usage/config error
- `3` no matched chats or no messages in the window
- `4` `--max-parts` guard
- `5` Dropbox/network/archive read error

## 10. Known expected behaviors

These are intentional. Do not report them as bugs unless the behavior differs
from this list.

- Archives include group chats, 1:1 chats and media, are encrypted in Dropbox
  and have no daily upload cap.
- Messages dated before installation stay local until **Sync messages dated
  before installation** is enabled.
- A startup catch-up scan archives messages WhatsApp already loaded into memory
  when the tab reopens (for example, messages received while it was closed). It
  is capped at 5,000 records per page load, never requests WhatsApp history and
  never downloads media; messages WhatsApp has not loaded stay uncaptured until
  their chat is opened.
- The CLI is independent of the extension and reads archive data with the
  account/key.
- The CLI reads Dropbox only. It cannot read the extension local IndexedDB
  archive. Uploads must be enabled and completed before a chat or media item is
  visible to the CLI.
- Offloaded text is removed from the local IndexedDB archive but remains
  in Dropbox. The CLI reads the Dropbox copy.
- Clearing the local archive does not delete Dropbox objects.
- The extension writes encrypted archives only.
- The encryption key is locked once local data exists. Changing it requires
  clearing the local archive; changing the alias or Dropbox account can pause
  upload/offload until the old archive is restored.
- `dt=` uses the capturing browser's local date. The CLI pads the date range by
  one day and filters by exact timestamps.
- Media export covers images, stickers and GIFs. Video, audio and documents are
  metadata/placeholders only.
- The extension media limit is configurable up to 50 MiB; the CLI's default
  media export limit is 25 MiB. Use `--media-max-bytes` when needed.
- Two browser profiles using the same alias, Dropbox account and app key write
  to the same Dropbox archive. Use one alias per WhatsApp account and a separate
  profile per account.
- If the CLI cannot find `_format.json` (wrong alias, wrong app key, or no
  upload yet), record the actual error message. A missing archive should ideally
  be distinguishable from an encrypted archive without a key.

## 11. Out of scope

- AI tool consumption, prompt quality and model evaluation.
- Personal-build view-once capture.
- Automated cross-repository contract tests.
- Chrome Web Store review, WhatsApp policy review and legal review.

## 12. Cleanup

After the manual run:

- [ ] Delete local NDJSON, text, CSV and media export directories.
- [ ] Delete the test archive key from the shell history and temporary notes.
- [ ] Run `waidrop auth --revoke` if the CLI was connected on a shared machine.
- [ ] Disconnect the extension from Dropbox if the test account is disposable.
- [ ] Delete the disposable Dropbox App Folder if it is no longer needed.
- [ ] Remove test Chrome profiles or the unpacked extension.
- [ ] Do not commit exported archives, media, manifests or keys to either repo.
