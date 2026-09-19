//! THE SOURCE THIS APP IS ON — one authority, one order (MJXHRM-602).
//!
//! Every WebView runs its own fold over its own socket, so "which connection is
//! the app on" has to be decided somewhere they all agree. Electron has its main
//! process; universal has this. The webviews used to order their own switches
//! with wall clocks and a broadcast, and every review found a new race in it.
//!
//! The model — the implementation and its review are checked against this:
//!
//!  * STATE. `current = { connection_id, seq, dial_seq }`, process-local and
//!    never persisted (`last_used` is what survives a restart). `seq` counts
//!    every commit; `dial_seq` is the `seq` at which a window already on
//!    `connection_id` last had to re-dial — the source moved to another row, or
//!    its row's dial fields were edited. `connection_id` is `None` when there is
//!    no row to be on (a phone with nothing configured).
//!
//!  * LAUNCH is decided ONCE per process, here, on the first read: the launch
//!    mode names the primary or the last-used row (a dangling last-used falls
//!    back to the primary; no rows → none), with `seq = 1`. No window decides
//!    launch: main, instance, tile, HUD and activity all READ it, so a window
//!    opened later lands on the source the app is on, whatever the launch mode.
//!
//!  * A SWITCH COMMITS HERE. After its preflight a window calls
//!    `connections_commit_source`, which — under one lock — checks the row still
//!    exists, remembers it as `last_used`, takes the next `seq` and announces
//!    `{connection_id, seq, dial_seq}` to every window. A missing row fails and
//!    changes nothing.
//!
//!  * EVERY WINDOW APPLIES A COMMIT THE SAME WAY (`applySource`,
//!    `store/connections.ts`): ignore `seq <= applied`; else record it and
//!    supersede whatever the window had in flight — a local preflight or an
//!    older apply — then re-home, unless it is already on that row and has
//!    dialled it since `dial_seq`. The window that committed applies its own
//!    commit from the command's return value; the announcement that follows
//!    carries the same `seq` and is a no-op.
//!
//!  * THE ROW UNDER THE SOURCE. Removing it moves the source to the primary
//!    (desktop's `disposeSecondariesForConnection` → `setActive(primaryProfile)`,
//!    and `removeConnection`'s `lastUsed → primary`), or to none when no row is
//!    left; editing its dial fields re-commits the same row with a new
//!    `dial_seq`, which is desktop's `updated` push (dispose, then re-dial).
//!    Both are commits like any other: a new `seq`, announced to every window.
//!    Signing out is not one — the app stays on the row, as desktop's does.
//!
//! This file is the pure half, so it can be tested with no app attached; the
//! lock, the write and the announcement are `mod.rs`'s.

use std::collections::BTreeSet;

use serde::Serialize;

use super::error::ConnectionsError;
use super::registry::{LaunchMode, Registry};

/// What every window is told, and what a booting window reads. Nothing secret:
/// the id of a registry row and two counters.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentSource {
    pub connection_id: Option<String>,
    pub seq: u64,
    pub dial_seq: u64,
}

/// `None` until launch is decided; guarded by `ConnectionsState::source`.
#[derive(Default)]
pub struct SourceBook {
    current: Option<CurrentSource>,
    /// Interrupted sign-ins already resumed by some window of this process.
    resumed: BTreeSet<String>,
}

fn has(registry: &Registry, id: &str) -> bool {
    registry.connections.iter().any(|row| row.id == id)
}

/// Where the app launches: the launch mode's row, if the registry still has it.
pub fn launch_target(registry: &Registry) -> Option<String> {
    let last_used = if has(registry, &registry.last_used) {
        &registry.last_used
    } else {
        &registry.primary
    };

    let target = match registry.launch_mode {
        LaunchMode::Primary => &registry.primary,
        LaunchMode::LastUsed => last_used,
    };

    has(registry, target).then(|| target.clone())
}

impl SourceBook {
    pub fn current(&self) -> Option<&CurrentSource> {
        self.current.as_ref()
    }

    /// Where the app is, deciding launch if nobody has yet. `true` only for the
    /// call that decided.
    pub fn launch(&mut self, registry: &Registry) -> (CurrentSource, bool) {
        if let Some(held) = &self.current {
            return (held.clone(), false);
        }

        let decided = CurrentSource {
            connection_id: launch_target(registry),
            dial_seq: 1,
            seq: 1,
        };

        self.current = Some(decided.clone());

        (decided, true)
    }

    fn advance(&mut self, connection_id: Option<String>, redial: bool) -> CurrentSource {
        let (seq, dialled, moved) = match &self.current {
            Some(held) => (
                held.seq + 1,
                held.dial_seq,
                held.connection_id != connection_id,
            ),
            None => (1, 1, true),
        };

        let next = CurrentSource {
            connection_id,
            dial_seq: if moved || redial { seq } else { dialled },
            seq,
        };

        self.current = Some(next.clone());

        next
    }

    /// A window's switch. The returned source is what gets announced.
    pub fn commit(
        &mut self,
        registry: &Registry,
        connection_id: &str,
    ) -> Result<CurrentSource, ConnectionsError> {
        if !has(registry, connection_id) {
            return Err(ConnectionsError::not_found(connection_id));
        }

        Ok(self.advance(Some(connection_id.to_string()), false))
    }

    /// The source's row had its dial fields edited: same row, re-dial.
    pub fn row_edited(&mut self, connection_id: &str) -> Option<CurrentSource> {
        let on_it = self
            .current
            .as_ref()
            .is_some_and(|held| held.connection_id.as_deref() == Some(connection_id));

        on_it.then(|| self.advance(Some(connection_id.to_string()), true))
    }

    /// A row was removed. When it was the source's, move to the primary — or to
    /// none when no row is left. `after` is the registry once repaired.
    pub fn row_removed(&mut self, after: &Registry) -> Option<CurrentSource> {
        // On no row at all, or on one that is still there: nothing moved.
        self.current
            .as_ref()?
            .connection_id
            .as_deref()
            .filter(|id| !has(after, id))?;

        let fallback = has(after, &after.primary).then(|| after.primary.clone());

        Some(self.advance(fallback, false))
    }

    /// The registry was seeded from the pre-registry target AFTER a window had
    /// already asked where the app is: launch is asked again, of the real rows.
    pub fn reseeded(&mut self, after: &Registry) -> Option<CurrentSource> {
        let held = self.current.as_ref()?;
        let target = launch_target(after);

        (target != held.connection_id).then(|| self.advance(target, false))
    }

    /// First caller wins: an interrupted sign-in is finished by one window.
    pub fn claim_resume(&mut self, marker: &str) -> bool {
        self.resumed.insert(marker.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::super::registry::{Connection, ConnectionKind};
    use super::*;

    fn row(id: &str) -> Connection {
        Connection {
            auth_mode: None,
            header_names: Vec::new(),
            host: None,
            id: id.to_string(),
            key_path: None,
            kind: ConnectionKind::Remote,
            label: id.to_string(),
            order: 0,
            org: None,
            port: None,
            remote_hermes_path: None,
            remote_profile: None,
            url: Some(format!("https://{id}.test")),
            user: None,
        }
    }

    fn registry(ids: &[&str], last_used: &str, launch_mode: LaunchMode) -> Registry {
        Registry {
            connections: ids.iter().map(|id| row(id)).collect(),
            last_used: last_used.to_string(),
            launch_mode,
            primary: ids.first().map(|id| id.to_string()).unwrap_or_default(),
            ..Registry::default()
        }
    }

    fn id(source: &CurrentSource) -> Option<&str> {
        source.connection_id.as_deref()
    }

    #[test]
    fn launch_follows_the_mode_and_falls_back_when_the_last_used_row_is_gone() {
        let last = registry(&["home", "studio"], "studio", LaunchMode::LastUsed);
        let primary = registry(&["home", "studio"], "studio", LaunchMode::Primary);
        let dangling = registry(&["home", "studio"], "removed", LaunchMode::LastUsed);

        assert_eq!(launch_target(&last).as_deref(), Some("studio"));
        assert_eq!(launch_target(&primary).as_deref(), Some("home"));
        assert_eq!(launch_target(&dangling).as_deref(), Some("home"));
        // A phone with nothing configured has no row to name.
        assert_eq!(
            launch_target(&registry(&[], "local", LaunchMode::Primary)),
            None
        );
    }

    #[test]
    fn launch_is_decided_once_and_every_later_reader_gets_the_same_source() {
        let mut book = SourceBook::default();
        let at_start = registry(&["home", "studio"], "studio", LaunchMode::Primary);

        let (decided, first) = book.launch(&at_start);

        assert!(first, "the first read decides");
        assert_eq!(
            (id(&decided), decided.seq, decided.dial_seq),
            (Some("home"), 1, 1)
        );

        // A window opened after the person moved to `studio` reads the book; the
        // launch mode is not asked again.
        book.commit(&at_start, "studio").expect("studio exists");

        let (read, decided_again) = book.launch(&at_start);

        assert!(!decided_again);
        assert_eq!((id(&read), read.seq), (Some("studio"), 2));
    }

    #[test]
    fn a_commit_takes_the_next_seq_and_is_what_gets_announced() {
        let mut book = SourceBook::default();
        let rows = registry(&["home", "studio"], "home", LaunchMode::LastUsed);

        book.launch(&rows);

        let moved = book.commit(&rows, "studio").expect("studio exists");

        assert_eq!(
            (id(&moved), moved.seq, moved.dial_seq),
            (Some("studio"), 2, 2)
        );
        assert_eq!(book.current(), Some(&moved));

        // The same row again (a re-apply, another profile): a new seq, and no
        // window already on it has to re-dial.
        let again = book.commit(&rows, "studio").expect("studio exists");

        assert_eq!(
            (id(&again), again.seq, again.dial_seq),
            (Some("studio"), 3, 2)
        );
    }

    #[test]
    fn committing_a_missing_row_fails_and_changes_nothing() {
        let mut book = SourceBook::default();
        let rows = registry(&["home"], "home", LaunchMode::LastUsed);

        book.launch(&rows);

        let before = book.current().cloned();
        let refused = book.commit(&rows, "gone").expect_err("no such row");

        assert_eq!(refused.kind, super::super::ConnectionsErrorKind::NotFound);
        assert_eq!(book.current().cloned(), before);
    }

    #[test]
    fn removing_the_sources_row_moves_it_to_the_primary_with_a_new_seq() {
        let mut book = SourceBook::default();
        let rows = registry(&["home", "studio"], "studio", LaunchMode::LastUsed);

        book.launch(&rows);

        // Another row going is not the source's business.
        let mut others = rows.clone();

        others.connections.push(row("lab"));
        assert_eq!(book.row_removed(&others), None);

        let after = registry(&["home"], "home", LaunchMode::LastUsed);
        let moved = book.row_removed(&after).expect("the source's row went");

        assert_eq!(
            (id(&moved), moved.seq, moved.dial_seq),
            (Some("home"), 2, 2)
        );

        // The last row of a phone: the app is on nothing, and says so.
        let none = book
            .row_removed(&registry(&[], "local", LaunchMode::LastUsed))
            .expect("no row left");

        assert_eq!((id(&none), none.seq), (None, 3));

        // On no row, a removal has nothing to move: a saved-but-never-selected
        // row going must not put the app on the primary.
        assert_eq!(book.row_removed(&after), None);
    }

    #[test]
    fn a_seed_that_lands_after_launch_was_decided_asks_launch_again() {
        let mut book = SourceBook::default();

        assert_eq!(
            book.reseeded(&registry(&["studio"], "studio", LaunchMode::LastUsed)),
            None
        );

        book.launch(&registry(&["local"], "local", LaunchMode::LastUsed));

        let seeded = book
            .reseeded(&registry(
                &["local", "studio"],
                "studio",
                LaunchMode::LastUsed,
            ))
            .expect("the seed names another row");

        assert_eq!((id(&seeded), seeded.seq), (Some("studio"), 2));
        assert_eq!(
            book.reseeded(&registry(
                &["local", "studio"],
                "studio",
                LaunchMode::LastUsed
            )),
            None
        );
    }

    #[test]
    fn editing_the_sources_dial_fields_recommits_it_for_a_redial() {
        let mut book = SourceBook::default();
        let rows = registry(&["home", "studio"], "home", LaunchMode::LastUsed);

        book.launch(&rows);

        assert_eq!(book.row_edited("studio"), None);

        let redial = book.row_edited("home").expect("the app is on it");

        assert_eq!(
            (id(&redial), redial.seq, redial.dial_seq),
            (Some("home"), 2, 2)
        );
    }

    #[test]
    fn the_order_is_never_persisted() {
        let mut book = SourceBook::default();
        let rows = registry(&["home", "studio"], "home", LaunchMode::LastUsed);

        book.launch(&rows);
        book.commit(&rows, "studio").expect("studio exists");

        // The book is not part of the document, and the document has no field
        // that could carry it.
        let document = serde_json::to_string(&rows).expect("serializable");

        assert!(!document.contains("seq") && !document.contains("Seq"));
        assert!(!document.contains("currentSource"));
    }

    #[test]
    fn an_interrupted_sign_in_is_resumed_by_one_window() {
        let mut book = SourceBook::default();

        assert!(book.claim_resume("a"));
        assert!(!book.claim_resume("a"));
        assert!(book.claim_resume("b"));
    }
}
