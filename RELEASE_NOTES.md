# NginUX v0.1.20

Authentication recovery release. This fixes the onboarding deadlock affecting a
new admin/editor when mandatory manager 2FA is enabled, and adds safe ways to
replace or recover a lost authenticator.

## Fixed

### New manager could not complete first login

An admin/editor created with a temporary password could owe both password change
and 2FA enrollment. The server evaluated both gates independently:

- password change was blocked because 2FA was not enrolled;
- 2FA enrollment was blocked because the temporary password was not changed.

Password onboarding now has explicit precedence. The account changes its
temporary password first, receives a fresh session, and the response carries the
computed policy flag that moves the UI directly to mandatory 2FA enrollment.

### Onboarding redirect loop

A manager signing in through a protected service could be redirected back to
that service before completing password/2FA onboarding, where forward-auth would
deny the incomplete session. Server-approved return redirects are now deferred
when onboarding is required, so the NginUX setup screens remain reachable.

### Existing user could not replace 2FA

The backend already kept the active authenticator safe while a replacement was
pending, but the UI hid all setup controls once 2FA was enabled. Users now have a
**Replace 2FA** action that:

- confirms the current password;
- keeps the old authenticator active until a code from the replacement verifies;
- rotates the secret and replay counter only after verification;
- revokes sessions established under the old factor and issues the verifying
  browser a fresh session;
- invalidates the old backup-code set and issues eight new codes.

### Lost-factor recovery for another user

An admin can now reset another user's 2FA when that user has lost both the
authenticator and backup codes. The recovery action:

- requires the acting admin's own password;
- cannot be used on the acting admin (self-service replacement is safer);
- clears active/pending authenticator secrets and backup codes;
- resets the TOTP replay watermark;
- revokes every target-user session;
- writes a security audit event.

If mandatory manager 2FA is enabled, the recovered admin/editor is confined to
fresh enrollment after the next password login.

## UX hardening

- The forced password screen now offers **Sign out**, so users can switch accounts.
- Enabling mandatory manager 2FA refreshes the current identity immediately and
  opens enrollment instead of leaving a stale UI that receives policy 403s.
- Normal app data is not loaded while password or 2FA onboarding is active.
- New-user copy explains the password-first, then-2FA onboarding order.

## Verification

- Server tests: **309 passed**
- Web tests: **338 passed**
- Real-Nginx integration: **24 cases in the release pipeline**
- Server/web typechecks and production build: passed
- npm audit: **0 known vulnerabilities**
