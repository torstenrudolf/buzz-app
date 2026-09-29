//! Local configuration and process ownership; never tied to a page or relay session.
//! No legacy desktop dependency, implicit identity creation, or credential projection.
mod agent_defaults;
mod bundle;
mod community;
mod config;
pub use community::CommunityResolution;
pub mod connection;
mod create;
mod credentials;
mod defaults;
mod import;
pub mod logs;
mod ownership;
pub mod pi;
mod process;
mod profile;
mod restart;
mod runtime;
mod secret;
mod store;
#[cfg(unix)]
mod supervisor;
#[cfg(unix)]
pub use supervisor::dispatch as dispatch_agent_supervisor;

pub use agent_defaults::{AgentDefaultsEdit, AgentDefaultsView};
pub use bundle::RuntimeBundle;
pub use config::{AgentEdit, AgentView, ControlSnapshot, HarnessEdit, ProcessStatus};
pub use create::{CreationProfile, NewAgent};
pub use credentials::PlatformCredentials;
pub use defaults::{build_defaults, BuildDefaults};
pub use import::{
    CloneSettings, CredentialedImport, ImportPreview, Imports, LegacySource, PreparedImport,
};
pub use restart::{RestartChange, RestartDiffEntry};
pub use runtime::{installed, managed_tool, Action, Controller, GooseModelContext, ModelContext};
pub use secret::{Credentials, Secret};
pub use store::{ParkedIdentity, Store};
type Result<T> = std::result::Result<T, String>;
