# Reach RPC test workspace

`WorkspaceFilesystem` defaults to a named `default` workspace at `~/.reach/workspace`. Callers must use a configured workspace name; unknown names are denied. Tests pass an isolated map such as `{ fixture: temporaryDirectory }`, which never reads or changes the user's home workspace.

Filesystem writes and edits require a gateway-issued scoped grant. The local gateway exposes `POST /grants` with `workspace`, `path`, and `methods` (`fs.write` and/or `fs.edit`); include the returned `grantId` as `permission.grantId` in the complete `reach-rpc/1.0` request envelope. Requests also require the `sessionId` returned by the session heartbeat.
