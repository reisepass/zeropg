# scratch

Ad-hoc, one-off probe scripts written during live debugging sessions (app
bring-ups, wire smoke tests, cold-start pokes). They used to live in the repo
root; they are kept here for reference, not as part of any suite.

Nothing here is wired into CI, `package.json` scripts, or the test runner. Most
assume a local zeropg wire on some hard-coded port, or a live Cloud Run URL that
may no longer exist. Read a script before running it.

Run them from the repo root so bare imports (`pg`, `@zeropg/client`) resolve:

```sh
node scripts/scratch/_pgtest.mjs
```

Maintained scripts (deploy, backup, gc, branch, nightly-reset) are one level up
in `scripts/`.
