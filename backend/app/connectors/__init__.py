"""External connectors: the built-in Google connector and user-added MCP servers.

See docs/connectors.md for the design. Everything here is per-process state
handed over by the client (definitions and decrypted secrets), never written
to backend files -- the same rule as the provider keys in
``/api/local/credentials``.
"""
