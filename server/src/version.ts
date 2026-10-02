// Single source of truth for the app version. Keep in sync with the
// package.json files (root, server, web) and package-lock.json.
//
// Changing this file on main is what triggers .github/workflows/release.yml:
// the workflow verifies, builds and publishes the image, and THEN creates the
// `v<VERSION>` git tag and GitHub Release itself. Never push that tag by hand -
// a pre-existing tag makes the release job refuse to run.
export const VERSION = "0.1.22";
