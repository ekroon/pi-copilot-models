# Security

This extension runs with the permissions of the Pi process. It uses Pi-managed
GitHub Copilot credentials and can observe model requests and usage metadata.
Install only from a repository or release you trust.

Credentials are not written to the catalog cache. The cache contains model
metadata, routing, the account's inference endpoint, and a one-way credential
fingerprint. Treat it as local account-related data; do not upload it casually.
Settled-usage observation is in memory and does not persist raw response bodies.

Use current Pi and Node.js releases for upstream security fixes. The compatibility
minimum is not a recommendation to use an older host. Development dependencies
are locked and audited; Pi supplies runtime peer dependencies itself.

If you find a vulnerability, use the repository's private security advisory
reporting feature if available. Otherwise contact the maintainer privately via
their GitHub profile to arrange a secure report. Do not post credentials,
authorization headers, account data, or raw prompts/responses in public issues.
Include affected versions, a minimal sanitized reproduction, and the impact.
