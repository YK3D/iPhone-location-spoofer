#!/bin/sh
# Vercel's "Ignored Build Step" (vercel.json ignoreCommand), run from website/: exit 0 skips the build,
# exit 1 builds. Skip only when we can see that nothing the site uses changed since the last deployment
# of this branch: the site itself, the documents it shows as pages, and ui/app.js (theme count).
# Anything uncertain (a branch's first deployment, a commit missing from the shallow clone) builds.
prev="$VERCEL_GIT_PREVIOUS_SHA"
if [ -z "$prev" ] || ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
  echo "No previous deployment to compare with: building."
  exit 1
fi
if git diff --quiet "$prev" HEAD -- . ../TERMS.md ../PRIVACY.md ../LICENSE ../THIRD_PARTY_NOTICES.md ../CHANGELOG.md ../ui/app.js; then
  echo "Nothing the website uses changed since $prev: skipping the build."
  exit 0
fi
echo "The website or a file it shows changed since $prev: building."
exit 1
