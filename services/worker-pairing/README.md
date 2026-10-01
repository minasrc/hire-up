# Pair a Mac with Agora

Pairing creates an owner/workspace-scoped worker credential. It does not connect
Telegram, start services, install launch agents, or configure a model provider.
Use Node 22. No additional package installation is needed for this command.

1. Sign into Agora with MFA, open Connect Telegram, choose **Pair this Mac**, and
   create an invitation. Leave the browser open for fingerprint confirmation.
2. Run this command with your platform's HTTPS origin and a new private directory:

   ```sh
   node services/worker-pairing/cli.mjs --server https://your-platform.example --directory /absolute/private/agora-device --name 'My Mac'
   ```

3. Paste the browser's `UUID.secret` invitation into the hidden terminal prompt.
   Never place it in an argument, environment variable, URL, shared document or log.
   The command requires an interactive terminal; piped secrets are rejected.
4. Compare the 12-character fingerprint displayed locally with the browser. Only
   confirm if they match. The Mac polls every five seconds, respecting rate limits.
5. Approval saves `credential.json` with owner-only access. The file is exactly:

   ```json
   {"version":1,"server":"https://your-platform.example","workerId":"UUID","token":"PRIVATE_WORKER_TOKEN","name":"My Mac","expiresAt":"ISO8601","organization":{"id":"UUID","name":"Workspace name"}}
   ```

The token is generated on the Mac and never returned through the browser. Treat
this file and the directory as private credentials. The pairing state is protected
by filesystem ownership and permissions, not the macOS Keychain or hardware.
The directory must be owned by you with mode0700; files must be0600. Symlink paths
and linked credential files are rejected. Credentials and partial pairing state
are never silently replaced. Avoid shared or cloud-synced directories.

After Ctrl-C or a network interruption, resume the same original invitation:

```sh
node services/worker-pairing/cli.mjs --directory /absolute/private/agora-device
```

The command preserves its token/verifier/claim identity before its first request.
Lost claim acknowledgements reconcile through verifier polling, then exact claim
replay if needed. A final approved credential is atomically persisted before the
pending verifier is removed. Restart completes cleanup after a crash between those
steps. A configured directory remains configured. Expired, cancelled, rejected or
conflicting enrollment remains preserved for inspection; create a fresh invitation
and a new private directory rather than replacing uncertain state.

After a crash, `--directory /absolute/private/agora-device --unlock` removes the
process lock only if its recorded PID is confirmed stopped. Never delete state to
bypass a live process. Renew the same device in Agora before token expiry; renewal
preserves its token/UUID and existing encrypted job receipts. The local expiresAt
is enrollment metadata, not a locally enforced renewal deadline.

## Use the paired credential with the connector

In the existing private connector configuration, set:

```json
{"credentialFile":"/absolute/private/agora-device/credential.json","apiId":12345,"apiHash":"YOUR_LOCAL_TELEGRAM_API_HASH","stateDirectory":"/absolute/private/telegram-state"}
```

Start as documented in `../telegram-connector/README.md`. Alternatively use the
nonsecret path environment variable `TELEGRAM_CONNECTOR_CREDENTIAL_FILE`.
Existing inline/environment server, workerId and token settings remain supported;
when combined with credentialFile they must match, preventing accidental mixed
identities. Relative credentialFile paths resolve beside the connector config.
Telegram API credentials are separate and never sent to the pairing API.

Other worker configuration remains operator setup in this phase. Do not run the
legacy embedding worker. Normal decommission requires acknowledged Telegram
logout before revoking the device; emergency revocation stops hosted access but
cannot guarantee logout or erase this Mac. Keep local session state until resolved.

## Verification

```sh
node --test tests/unit/worker-pairing-mac.test.js
```

Tests use synthetic invitations, private disposable files and injected HTTP only.
HTTPS is required except loopback HTTP for tests. The CLI opens no listener, sends
no cookies, follows no redirects, limits requests to2KiB and responses to8KiB,
and uses ten-second deadlines. Errors/logs use fixed codes and never include
provider response text, invitations, verifier or worker token.
