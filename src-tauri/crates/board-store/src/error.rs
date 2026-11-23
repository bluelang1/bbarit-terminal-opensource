//! `StoreError`: a store refusal or failure with a stable kind, for a program that has to act
//! on the kind (an HTTP server mapping it to a status, a worker deciding to retry) without
//! matching message text. `Display` prints exactly the message the app shows, so turning a
//! `StoreError` into a `String` (`From`, `to_string`) gives today's text.
//!
//! The PostgreSQL engine's on-connection operations (`pg::PgOps`) and the input checks shared
//! by both engines return it; `BoardStore`, `PgStore` and the SQLite engine keep returning
//! `String` (the message).

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The team, task or dependency named does not exist (live).
    NotFound(String),
    /// The task or board is not in a state that allows the change: wrong state, changed since
    /// it was loaded (version), already done, a dependency cycle, a cap reached, a duplicate.
    Conflict(String),
    /// The caller held this task, but its lease ran out (or the app released it) and it was
    /// taken from them; claim it again (or a ready one) instead of finishing it.
    LeaseLost(String),
    /// The actor may not do this (not the owner, not the creator, a person working on a task,
    /// a team that another computer owns, an announcement from a member tab).
    Forbidden(String),
    /// The request itself is malformed or out of bounds (team id, kind, text limits, flags).
    Invalid(String),
    /// A deadlock or serialization failure: retry the whole transaction.
    Busy(String),
    /// The database cannot be used right now: unreachable, timed out, no or wrong board tables,
    /// missing privileges, a connection or pool problem.
    Unavailable(String),
    /// Anything else (an unexpected database error, a row that does not decode).
    Internal(String),
}

impl StoreError {
    /// Stable machine-readable kind: `not_found`, `conflict`, `lease_lost`, `forbidden`,
    /// `invalid`, `busy`, `unavailable` or `internal`.
    pub fn kind(&self) -> &'static str {
        match self {
            StoreError::NotFound(_) => "not_found",
            StoreError::Conflict(_) => "conflict",
            StoreError::LeaseLost(_) => "lease_lost",
            StoreError::Forbidden(_) => "forbidden",
            StoreError::Invalid(_) => "invalid",
            StoreError::Busy(_) => "busy",
            StoreError::Unavailable(_) => "unavailable",
            StoreError::Internal(_) => "internal",
        }
    }

    /// The message as people see it (the same text `Display` prints).
    pub fn message(&self) -> &str {
        match self {
            StoreError::NotFound(m)
            | StoreError::Conflict(m)
            | StoreError::LeaseLost(m)
            | StoreError::Forbidden(m)
            | StoreError::Invalid(m)
            | StoreError::Busy(m)
            | StoreError::Unavailable(m)
            | StoreError::Internal(m) => m,
        }
    }

    pub fn into_message(self) -> String {
        match self {
            StoreError::NotFound(m)
            | StoreError::Conflict(m)
            | StoreError::LeaseLost(m)
            | StoreError::Forbidden(m)
            | StoreError::Invalid(m)
            | StoreError::Busy(m)
            | StoreError::Unavailable(m)
            | StoreError::Internal(m) => m,
        }
    }

    /// Worth running the whole transaction again (deadlock, serialization failure).
    pub fn is_retryable(&self) -> bool {
        matches!(self, StoreError::Busy(_))
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for StoreError {}

impl From<StoreError> for String {
    fn from(e: StoreError) -> String {
        e.into_message()
    }
}

#[cfg(test)]
mod tests {
    use super::StoreError;

    #[test]
    fn display_is_the_message_and_kind_is_stable() {
        let all = [
            (StoreError::NotFound("no task #3 in team t".into()), "not_found"),
            (StoreError::Conflict("c".into()), "conflict"),
            (StoreError::LeaseLost("l".into()), "lease_lost"),
            (StoreError::Forbidden("f".into()), "forbidden"),
            (StoreError::Invalid("i".into()), "invalid"),
            (StoreError::Busy("b".into()), "busy"),
            (StoreError::Unavailable("u".into()), "unavailable"),
            (StoreError::Internal("x".into()), "internal"),
        ];
        for (e, kind) in all {
            assert_eq!(e.kind(), kind);
            assert_eq!(e.to_string(), e.message());
            assert_eq!(String::from(e.clone()), e.message());
            assert_eq!(e.is_retryable(), kind == "busy");
        }
        assert_eq!(StoreError::NotFound("no task #3 in team t".into()).to_string(), "no task #3 in team t");
    }
}
