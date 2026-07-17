# Vendored Hammersmith runtime

- Upstream: https://github.com/Fornace/hammersmith
- Commit: `296df0047ba01ebe7e12b772ce443b6318a5fbb0`
- Package version: `0.1.0`
- Source archive: `hammersmith-0.1.0+296df004.tar.gz`

The archive is produced only from tracked files at the immutable commit:

```sh
git archive --format=tar.gz --prefix=hammersmith-0.1.0/ \
  -o hammersmith-0.1.0+296df004.tar.gz \
  296df0047ba01ebe7e12b772ce443b6318a5fbb0 \
  pyproject.toml README.md LICENSE.md NOTICE.md hammersmith
```

`hammersmith-entry.py` is Waynode's small image entry point. The pinned
upstream parser does not expose a global `--version` option, so the entry point
provides the packaging assertion and otherwise calls the upstream CLI directly.
It never invokes a shell.
