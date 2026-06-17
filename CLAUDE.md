# minercon — assistant working notes

## Pull requests

- After pushing a branch, open a PR for it (unless one is already open for that
  branch, in which case the push just updates it). This is the default — no need
  to ask first.
- After opening a PR in a session, immediately subscribe to its activity
  (`subscribe_pr_activity`) and watch it until it is merged or closed —
  investigating CI failures and review comments as they arrive and acting on
  them (fix when confident and small, ask when ambiguous, skip when no action
  is needed). Do this by default; no need to ask first.
