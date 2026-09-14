//! PURE back/forward model for a guest that will not answer the question.
//!
//! The Electron desktop app asks Chromium (`canGoBack()`); nothing in
//! tauri 2.11 or wry 0.55 exposes a history API at all — only `reload`. So we
//! COUNT, using `history.length` read back from the page, and we say that we
//! are counting: every `browser://{id}/nav` carries a `historySource`, and the
//! two mobile adapters report `engine` because their platform views really do
//! answer. The UI can then say "back may be unavailable" instead of lying.
//!
//! The design's `observe(len, same_document)` lost its second argument here:
//! `history.length` alone already distinguishes a push (it grows) from a
//! replace (it does not), and a same-document flag we would have to synthesise
//! from `on_page_load` would be a second, less reliable source for the same
//! fact.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    Back,
    Forward,
    Push,
}

#[derive(Debug)]
pub struct HistoryModel {
    position: usize,
    length: usize,
    pending: Option<Move>,
}

impl Default for HistoryModel {
    fn default() -> Self {
        Self {
            position: 0,
            length: 1,
            pending: None,
        }
    }
}

impl HistoryModel {
    /// Record an intent before it reaches the page, so the settle read can be
    /// attributed to it.
    pub fn will_move(&mut self, m: Move) {
        self.pending = Some(m);
    }

    /// Fold in the `history.length` read back after a navigation settles.
    /// Returns `(can_back, can_forward)`.
    pub fn observe(&mut self, len: usize) -> (bool, bool) {
        let len = len.max(1);

        match self.pending.take() {
            Some(Move::Back) => self.position = self.position.saturating_sub(1),
            Some(Move::Forward) => self.position = (self.position + 1).min(len - 1),
            // A push grows the length; a server-side 302 or `replaceState`
            // leaves it alone and must not move us.
            Some(Move::Push) | None => {
                if len > self.length {
                    self.position = len - 1;
                }
            }
        }

        self.length = len;
        self.position = self.position.min(len - 1);

        (self.position > 0, self.position + 1 < len)
    }

    /// A fresh guest, or one whose document was replaced wholesale.
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_push_makes_back_available() {
        let mut h = HistoryModel::default();
        assert_eq!(h.observe(1), (false, false));

        h.will_move(Move::Push);
        assert_eq!(h.observe(2), (true, false));
    }

    #[test]
    fn back_at_the_start_reports_no_more_back() {
        let mut h = HistoryModel::default();
        h.will_move(Move::Push);
        h.observe(2);

        h.will_move(Move::Back);
        assert_eq!(h.observe(2), (false, true));

        // Asking again from position 0 must not underflow.
        h.will_move(Move::Back);
        assert_eq!(h.observe(2), (false, true));
    }

    #[test]
    fn a_replace_does_not_move_the_position() {
        let mut h = HistoryModel::default();
        h.will_move(Move::Push);
        h.observe(2);
        h.will_move(Move::Push);
        h.observe(3);

        // A 302 replaces the entry: the length does not grow.
        assert_eq!(h.observe(3), (true, false));
    }

    #[test]
    fn it_clamps_against_a_shrinking_length() {
        // Neutralising the clamp (making `observe` ignore `len`) turns this red.
        let mut h = HistoryModel::default();
        for _ in 0..3 {
            h.will_move(Move::Push);
        }
        h.observe(4);

        // Navigating from a mid-stack position truncates the forward entries.
        assert_eq!(h.observe(2), (true, false));
    }

    #[test]
    fn reset_forgets_everything() {
        let mut h = HistoryModel::default();
        h.will_move(Move::Push);
        h.observe(5);
        assert_eq!(h.observe(5), (true, false));

        h.reset();
        assert_eq!(h.observe(1), (false, false));
    }
}
