---
"jazz-tools": patch
---

Repair pre-release SQLite caches with legacy watermark tables and empty retired outboxes on open. Preserve cached rows and current pending writes; refuse nonempty retired write encodings unchanged so they can be synced or resolved with the previous build first.
