//! FormLogic Backups, a plugin for OAIY: sealed backups of a FormLogic account's apps and forms,
//! kept on this computer.
//!
//! FormLogic seals each backup to a key held here, so the file means nothing to anyone who copies
//! it, or to the server afterwards. The key comes from twelve words the person writes down, so the
//! backups outlive this computer ([`keys`]). The plugin links itself to FormLogic with a sign-in of
//! its own ([`link`]), which is good for backups and nothing else, and FormLogic answers only once
//! the owner has approved this computer ([`client`]).
//!
//! OAIY starts this program and speaks JSON-RPC to it over stdin and stdout ([`protocol`]). OAIY's
//! commands can come from more than the plugin's page (a flow, an app script, the agent), so what
//! could do harm in the wrong hands is asked of the person in a window of the plugin's own
//! ([`native`]), which nothing else on the computer can answer for them ([`commands`]).
//!
//! Everything is kept in the folder OAIY gives the plugin, and goes when the plugin is uninstalled.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod client;
mod commands;
mod envelope;
mod identity;
mod jobs;
mod keys;
mod link;
mod native;
mod protocol;
mod run;
mod secret_file;
mod store;

fn main() {
    protocol::serve();
}
