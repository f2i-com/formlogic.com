# FormLogic Backups for OAIY

A process plugin that keeps sealed backups of a FormLogic account's apps and forms on the computer running OAIY. It adds to OAIY through OAIY's plugin format, and OAIY doesn't change.

What it does, how to install it and how to test it are in [`docs/FORMLOGIC_BACKUPS.md`](../../docs/FORMLOGIC_BACKUPS.md).

```sh
cargo test --features scripted-dialogs   # with the plugin's windows answered from a file
cargo build --release                    # what a package holds
node ../../scripts/package-oaiy-plugin.mjs --platform windows-x64 --binary <program>
```
