# Changelog

All notable changes to this fork of [grenagit/MMM-APOD](https://github.com/grenagit/MMM-APOD) are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Load the picture from NASA's new APOD API (`science.nasa.gov/wp-json/wp/v2/apod-basic/`) after the
  migration away from `api.nasa.gov/planetary/apod` (upstream PR
  [#7](https://github.com/grenagit/MMM-APOD/pull/7)).
- No "© null" line when the API sends no copyright (public-domain pictures).
- The short description no longer fails when the API sends no explanation.
- Failed requests back off exponentially (2.5 s, 5 s, … up to `updateInterval`) instead of retrying every
  2.5 s forever before the first picture; 403 and 429 no longer stop updates for good (`Retry-After` is honoured).
  Before the first picture the error is shown instead of "Loading…".
- Requests only the newest entry (`per_page=1`): 9 KB instead of 276 KB per request.
- Title, copyright and description are rendered as plain text: the short description no longer cuts HTML in the
  middle of a link, the "Explanation:" prefix is gone, and markup from the API can no longer inject elements.
- The image's `alt` text comes from the API.

### Changed

- `appid` is optional: NASA's current APOD API needs no key. Without one the module no longer shows
  "Please set the correct NASA appid" and loads the picture; a configured key is still sent as `api_key`.
- Biome as linter and formatter (`node --run lint`, `node --run lint:fix`); the code uses `const`/`let`,
  template literals and strict comparisons.
- `package.json`: lowercase package name, `type`, repository links to this fork.
- README config example without the surrounding `modules` array and with trailing commas; install
  instructions clone this fork.
- Added `CODE_OF_CONDUCT.md`, a Dependabot configuration, tests (`node --run test`, with a recorded API response)
  and a CI workflow (lint + tests); `package-lock.json` is versioned.

## [1.2.0]

Last upstream release by Grena: modern `fetch` API instead of `XMLHttpRequest`, background mode with
overlay, video thumbnails.
