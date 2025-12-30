# Releasing

This repo publishes the VS Code extension to the Marketplace via GitHub Actions.

## Prerequisites

- You must be a member of the `tornado` publisher on the VS Code Marketplace.
- GitHub secret must exist:
  - `VSCODE_MARKET_PAT`: a VS Code Marketplace Personal Access Token (PAT) with publish rights.

## Normal release (recommended)

1. Bump the extension version in `package.json`.
   - Follow semver: `major.minor.patch`.
   - The workflow verifies that the git tag matches `package.json`.

2. Commit the version bump.

3. Create and push a tag of the form `vX.Y.Z` that matches the version.

   Example for version `0.1.1`:

   - `git tag v0.1.1`
   - `git push origin v0.1.1`

4. GitHub Actions will:
   - run unit tests and E2E tests (using the mock EasyCrypt)
   - build a `.vsix`
   - create a GitHub Release with the `.vsix` attached
   - publish to the VS Code Marketplace

## Manual publish (rare)

You can run the workflow manually (Actions → “Publish VSIX + Marketplace”) and set:
- `publish_to_marketplace = true`

This still requires the `VSCODE_MARKET_PAT` secret.

## Notes

- The mock-based E2E tests are the default in CI.
- The “real EasyCrypt” E2E test is opt-in and requires `EASYCRYPT_REAL_PATH`.
