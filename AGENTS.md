# JARVIS repository guidance

Understand the current implementation from README.md and docs/architecture.md
before changing a subsystem. Treat source code as authoritative if documentation
has drifted, and correct the documentation as part of the change.

## Keep documentation current

For every app change, update README.md in the same work:
- Update affected behavior, configuration, build/run instructions, or limitations.
- Add a concise dated entry under Maintenance and latest changes.
- Update docs/architecture.md when a boundary, protocol, provider, dependency,
  persistence policy, or platform behavior changes.
- State validation actually performed; distinguish source changes, built artifacts,
  installation and on-device verification. Do not claim one implies the others.

This is a documentation maintenance rule, not a requirement for user approval or
an instruction to launch recurring tasks.

## Preserve existing features and user data

This is a private personal app. Preserve the user's selected voice/language,
half-duplex default, tool-driven voice surfaces, editing and deletion safeguards,
and desktop/Android storage ownership unless the task explicitly changes them.
Never populate or delete real user records for tests. Use isolated fixtures.
Do not modify generated Android Python copies instead of backend/app sources.
Do not overwrite unrelated working-tree changes or print credential values.

Use focused checks for the changed behavior. Native builds share frontend outputs,
so build them sequentially. Read live-test headers before running tests that use
provider credits or a database. Update documentation after final checks so it
records the outcome accurately.
