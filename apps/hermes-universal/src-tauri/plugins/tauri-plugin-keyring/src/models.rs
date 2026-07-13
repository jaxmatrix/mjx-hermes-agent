use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CredentialType {
    Password, // UTF-8 strings
    Secret,   // Binary data (Vec<u8>)
}

impl std::fmt::Display for CredentialType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CredentialType::Password => write!(f, "password"),
            CredentialType::Secret => write!(f, "secret"),
        }
    }
}

// Simple result wrapper that can hold either type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum CredentialValue {
    Password(String),
    Secret(Vec<u8>),
}
