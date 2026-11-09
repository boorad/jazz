---
"jazz-tools": patch
---

Allow readers to download the current large value when its read permission was granted after the content was written. Chunk pulls, access proofs, and delta bases use current permission for the exact current accepted row version; older versions still require historical permission, and revoked access blocks every version. Add direct and relay regressions and durable native relay reopen coverage.
