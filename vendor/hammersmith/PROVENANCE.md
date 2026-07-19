# Vendored Hammersmith runtime

- Upstream: https://github.com/Fornace/hammersmith
- Commit: `1fcefd80734aa87d56211b21aa9a9d2fccc75a35`
- Package version: `0.1.0`
- Source archive: `hammersmith-0.1.0+1fcefd80.tar.gz`

The archive is produced only from tracked files at the immutable commit:

```sh
git archive --format=tar.gz --prefix=hammersmith-0.1.0/ \
  -o hammersmith-0.1.0+1fcefd80.tar.gz \
  1fcefd80734aa87d56211b21aa9a9d2fccc75a35 \
  pyproject.toml README.md LICENSE.md NOTICE.md hammersmith
```

`hammersmith-entry.py` is Waynode's small image entry point. The pinned
upstream parser does not expose a global `--version` option, so the entry point
provides the packaging assertion and otherwise calls the upstream CLI directly.
It never invokes a shell.
