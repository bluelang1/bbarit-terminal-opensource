//! Thin standalone binary for the BBARIT coding agent. All logic lives in the
//! library (`src/lib.rs`) so the host app (octo-ui / BBARIT Terminal) can embed
//! and run the agent fully in-process. This binary just forwards to `run()` so
//! the agent can still be built and run on its own during development.
fn main() -> anyhow::Result<()> {
    bbarit::run()
}
