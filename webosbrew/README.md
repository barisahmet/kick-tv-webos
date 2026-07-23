# Submitting Kick TV to the webOS Homebrew Channel

The Homebrew Channel app catalog lives at
https://github.com/webosbrew/apps-repo. An app is added by opening a pull
request that drops one YAML file into that repo's `packages/` folder. Everything
needed is already prepared here.

## What is already set up

- The release workflow builds the `.ipk` and also writes and attaches
  `org.webosbrew.manifest.json` to every tagged release. The manifest holds the
  app id, version, title, icon URL, source URL, the `.ipk` file name, and the
  `.ipk` sha256 hash. It regenerates on each release, so the "latest" URL always
  points at the current build:
  https://github.com/barisahmet/kick-tv-webos/releases/latest/download/org.webosbrew.manifest.json
- `com.barisahmet.kicktv.yml` in this folder is the package file to submit.

## How to submit

1. Make sure at least one tagged release exists, so `releases/latest` resolves to
   a real manifest and `.ipk`.
2. Fork https://github.com/webosbrew/apps-repo.
3. Copy `webosbrew/com.barisahmet.kicktv.yml` from this repo into the fork's
   `packages/` folder.
4. Open a pull request. The maintainers review and test it; once merged, the app
   appears in the Homebrew Channel for everyone.

## Notes

- `pool: main` because this is open source (MIT).
- `category: multimedia`.
- If you rename the repo or move the icon, update `iconUri` and `manifestUrl` in
  the package file, and `iconUri`/`sourceUrl` in the workflow's manifest step.
