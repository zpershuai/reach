# Reach RPC test workspace

`WorkspaceFilesystem` defaults to `~/.reach/workspace`. Tests pass an isolated directory made with `mkdtemp()` as the constructor root; this is the supported test-workspace override and never reads or changes the user's home workspace.
