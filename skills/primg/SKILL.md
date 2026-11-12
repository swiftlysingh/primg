---
name: primg
description: Use when sharing screenshots as visual evidence for UI validation, pull requests, or reports, or when asked for an image URL.
---

# primg

Keep screenshots in a temporary directory, never in the project repo.
Upload only images safe to share publicly, including their embedded metadata.
Links are public and do not expire automatically.

Run `primg` directly. It uses `PRIMG_TOKEN` and `PRIMG_HOST` from the
environment when they are set, and otherwise reads the unset values from
`~/.config/primg/env`. Never print, log, or commit the token. If `primg`
reports that the token is required, report that blocker and do not open the
credential file.

Upload a local PNG, JPEG, or WebP up to 20 MiB:

```sh
primg /tmp/screenshot.png
```

The CLI uses `https://img.swifti.ng` by default and prints the image URL.
Verify the returned URL starts with `https://img.swifti.ng/f/`
and serves the uploaded image without authentication. Use that URL in the
report or PR as `![Screen description](URL)`.
