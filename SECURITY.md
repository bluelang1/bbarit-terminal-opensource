# Security

BBARIT Terminal is a desktop development environment with shell, filesystem, browser, and agent capabilities. It runs with the permissions of the current OS user. Review commands, agent instructions, imported skills, and project contents before allowing them to act on sensitive workspaces.

Keep development/debug bridges on a trusted local machine. Do not expose their ports through a reverse proxy, tunnel, or untrusted network. A local development build is not a hosted multi-user service or a sandbox for untrusted code.

Supply external service credentials locally. User configuration and agent sessions can contain credentials and private project information; do not commit local environment files, browser profiles, databases, signing material, logs, or `.octo-tmp` captures. The source exporter excludes these paths and scans known secret formats, but pattern checks cannot detect every secret.

Use a dedicated temporary project and test credentials for verification. Native macOS and Windows behavior must be checked separately. Public builds must use the open-source build wrapper, without the original release signing identities, updater endpoints, or private deployment scripts.

Report vulnerabilities privately through the repository's private vulnerability reporting feature when available, or contact the maintainers privately through their GitHub profile. Do not post credentials, private captures, or exploit details in a public issue. Include the affected revision, platform, minimal reproduction, and expected/actual behavior with sensitive values removed.

No security support lifetime or completed independent security audit is claimed by this source release.
