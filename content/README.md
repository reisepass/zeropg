# Content series: zeropg posts

Blog posts + tweet threads about the zeropg research project, ready to publish.
Each post stands alone, is built on one measured insight from the repo, and links back
to the evidence. Suggested cadence: one post every 3-4 days, thread the same day.

The through-line of the whole series: **simple scale-to-zero Postgres is possible
today, if you accept migrating later. And migrating later is cheap, because it was
real Postgres the whole time.**

| # | post | the one insight | pairs with thread |
|---|---|---|---|
| 1 | [posts/01-the-idea.md](posts/01-the-idea.md) | the idea manifesto: zero-idle-cost Postgres + a boring exit | [twitter/thread-01](twitter/thread-01-the-idea.md) |
| 2 | [posts/02-the-cold-start-equation.md](posts/02-the-cold-start-equation.md) | cold ≈ restore + app boot; the DB is not the bottleneck, your framework is | [twitter/thread-02](twitter/thread-02-cold-start.md) |
| 3 | [posts/03-the-bucket-is-the-database.md](posts/03-the-bucket-is-the-database.md) | one conditional PUT is the whole commit protocol | |
| 4 | [posts/04-bugs-the-crash-harness-caught.md](posts/04-bugs-the-crash-harness-caught.md) | war stories: the silent-data-loss bug and 13 friends | [twitter/thread-04](twitter/thread-04-war-stories.md) |
| 5 | [posts/05-durability-is-a-dial.md](posts/05-durability-is-a-dial.md) | ack-from-memory vs ack-from-bucket is a per-workload choice | |
| 6 | [posts/06-unmodified-apps.md](posts/06-unmodified-apps.md) | 8 real apps ran unmodified; the only recurring blocker was bundled extensions | |
| 7 | [posts/07-the-break-even-math.md](posts/07-the-break-even-math.md) | it is request spacing, not request count, that bills | |

Publishing notes:

- Post 1 is the anchor; publish first, link the others back to it.
- Posts 2, 4, and 7 are the most shareable (each has a counterintuitive punchline).
- Every number cited has a JSONL in `results/` or a doc in `docs/`; keep the links when
  cross-posting so readers can verify.
- If these should NOT be published from the repo, add `content/` to `.gitignore` and
  keep them local; they are self-contained markdown either way.
