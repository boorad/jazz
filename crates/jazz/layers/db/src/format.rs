//! The storage format a store's SQLite file was written in.
//!
//! Every file this engine writes carries one row in `_jazz_format`: the
//! version of the layout of its tables, history, sync bookkeeping and large
//! values. A table rather than `PRAGMA user_version`, because Durable Object
//! SQLite refuses that PRAGMA. Opening admits the file before anything
//! writes to it (not even the journal mode), so a refused file is left
//! byte-for-byte as it was:
//!
//! - an empty file is new: it is stamped with [`STORAGE_FORMAT`];
//! - a file stamped with [`STORAGE_FORMAT`] opens;
//! - any other stamp, and a file with tables but no stamp (one Jazz did not
//!   write, such as a Groove SQLite-adapter root), is refused with
//!   [`ErrorCode::UnsupportedStorageCodecs`].
//!
//! The Groove engine's native stores were RocksDB directories; a host that
//! keeps its store in a data directory refuses one with
//! [`refuse_groove_store`] instead of opening an empty SQLite file beside it.
//!
//! The pinned corpus in `crates/jazz/tests/storage_corpus.rs` holds a file
//! of each released format; a change to the layout that an older file would
//! not read bumps [`STORAGE_FORMAT`] and adds its corpus.

use std::path::Path;

use rusqlite::Connection;

use crate::options::{Error, ErrorCode};
use crate::values::{in_savepoint, storage};

/// The storage format this build writes and reads.
pub const STORAGE_FORMAT: i64 = 1;

const STAMP_TABLE: &str = "_jazz_format";

/// A store this build cannot read, with what gave it away.
pub(crate) fn unsupported(detail: impl std::fmt::Display) -> Error {
    Error::new(
        ErrorCode::UnsupportedStorageCodecs,
        format!(
            "unsupported storage format: {detail}; this build reads Jazz SQLite storage format \
             {STORAGE_FORMAT}. Delete the local store and resync from Core"
        ),
    )
}

/// Admit the file `conn` opened: stamp a new one, accept one in
/// [`STORAGE_FORMAT`], refuse anything else. Accepted pre-release format-1
/// files also receive the known watermark and empty-outbox layout repairs.
pub(crate) fn admit(conn: &Connection) -> Result<(), Error> {
    // A damaged header fails here (`file is not a database`), as a storage
    // error, before any write.
    let tables: Vec<String> = conn
        .prepare(
            // Durable Object SQLite keeps its own `_cf_*` tables in the file.
            "SELECT name FROM sqlite_master WHERE type = 'table' \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()
        })
        .map_err(storage)?;
    if tables.is_empty() {
        return conn
            .execute_batch(&format!(
                "CREATE TABLE {STAMP_TABLE} (version INTEGER NOT NULL); \
                 INSERT INTO {STAMP_TABLE} (version) VALUES ({STORAGE_FORMAT});"
            ))
            .map_err(storage);
    }
    if !tables.iter().any(|name| name == STAMP_TABLE) {
        return Err(unsupported(
            "this SQLite file has tables but no Jazz storage format stamp \
             (it was not written by Jazz's SQLite engine)",
        ));
    }
    let versions: Vec<rusqlite::types::Value> = conn
        .prepare(&format!("SELECT version FROM {STAMP_TABLE}"))
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()
        })
        .map_err(storage)?;
    match versions.as_slice() {
        [rusqlite::types::Value::Integer(STORAGE_FORMAT)] => upgrade_development_layouts(conn),
        [rusqlite::types::Value::Integer(version)] => Err(unsupported(format!(
            "this store was written in Jazz SQLite storage format {version}"
        ))),
        other => Err(Error::new(
            ErrorCode::Storage,
            format!("corrupt storage format stamp: {STAMP_TABLE} holds {other:?}"),
        )),
    }
}

/// Pre-release format 1 encoded pending uploads as wire messages. Only an
/// empty outbox can be upgraded without interpreting those retired codecs.
/// Refuse nonempty old outboxes before any write, so the old build can sync
/// them first. Never discard a pending or rejected user write.
fn upgrade_development_layouts(conn: &Connection) -> Result<(), Error> {
    let pending = table_columns(conn, "_jazz_pending")? == ["tx", "header"];
    let rejected = table_columns(conn, "_jazz_rejected_ops")? == ["tx", "n", "op"];
    if !pending && !rejected {
        return upgrade_watermarks(conn);
    }
    in_savepoint(conn, "development_layouts", || {
        let mut retired = Vec::new();
        if pending {
            retired.extend([
                "_jazz_pending",
                "_jazz_pending_items",
                "_jazz_pending_rows",
                "_jazz_pending_ops",
                "_jazz_pending_cells",
                "_jazz_pending_deltas",
                "_jazz_pending_reads",
                "_jazz_pending_read_rows",
            ]);
        }
        if rejected {
            retired.extend(["_jazz_rejected", "_jazz_rejected_ops"]);
        }
        for table in &retired {
            if table_columns(conn, table)?.is_empty() {
                continue;
            }
            let occupied: bool = conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table} LIMIT 1)"),
                    [],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if occupied {
                return Err(Error::new(
                    ErrorCode::UnsupportedStorageCodecs,
                    "this pre-release SQLite store has pending or rejected writes in a retired encoding; reopen it with the previous build and sync or resolve those writes before upgrading. The store has not been changed",
                ));
            }
        }
        if pending {
            conn.execute_batch("DROP TRIGGER IF EXISTS _jazz_pending_forget;")
                .map_err(storage)?;
        }
        for table in retired {
            conn.execute_batch(&format!("DROP TABLE IF EXISTS {table};"))
                .map_err(storage)?;
        }
        // Normal opening recreates the current pending tables and trigger.
        upgrade_watermarks(conn)
    })
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, Error> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut statement| statement.query_map([], |row| row.get(1))?.collect())
        .map_err(storage)
}

/// Watermark layout v1 was `(key, through)`; v2 adds nullable `context`.
/// Old engines can still read v2, so the enclosing storage format stays 1.
/// A v1 marker has no trustworthy read context: discard only these resume
/// hints, never cached rows, history or pending writes. Add and invalidate
/// atomically so an interrupted upgrade cannot expose context-free hints.
fn upgrade_watermarks(conn: &Connection) -> Result<(), Error> {
    let columns = table_columns(conn, "_jazz_watermarks")?;
    if columns == ["key", "through"] {
        in_savepoint(conn, "watermarks_v2", || {
            conn.execute_batch(
                "ALTER TABLE _jazz_watermarks ADD COLUMN context BLOB; \
                 DELETE FROM _jazz_watermarks;",
            )
            .map_err(storage)
        })?;
    }
    Ok(())
}

/// Whether `dir` is a RocksDB directory: the Groove engine's native store.
pub fn is_groove_store(dir: &Path) -> bool {
    dir.join("CURRENT").is_file()
        && std::fs::read_dir(dir).is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().starts_with("MANIFEST-"))
        })
}

/// Refuse `dir` if it is a store the Groove engine wrote (RocksDB), with
/// [`ErrorCode::UnsupportedStorageCodecs`]; it is not read or changed.
pub fn refuse_groove_store(dir: &Path) -> Result<(), Error> {
    if is_groove_store(dir) {
        return Err(unsupported(format!(
            "{} is a store written by the Groove engine (RocksDB), before SQLite",
            dir.display()
        )));
    }
    Ok(())
}
