---
name: primg
description: Use when sharing screenshots as visual evidence for UI validation, pull requests, or reports, or when asked for an image URL.
---

# primg

Keep screenshots in a temporary directory, never in the project repo.
Upload only images safe to share publicly, including their embedded metadata.
Links are public and do not expire automatically.

Use `PRIMG_TOKEN` from the local credential setup. Never print or commit it.
If the CLI or token is missing, report the blocker.

Upload a local PNG, JPEG, or WebP up to 20 MiB:

```sh
primg /tmp/screenshot.png
```

The CLI uses `https://img.swifti.ng` by default and prints the image URL.
Verify the returned URL starts with `https://img.swifti.ng/f/`
and serves the uploaded image without authentication. Use that URL in the
report or PR as `![Screen description](URL)`.
