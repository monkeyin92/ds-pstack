#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, and the most recent chat that
# operated in it. Emits a table sorted by size with a suggested bucket. Never
# deletes anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [repo-path]
#   repo-path defaults to the current repo.
#   -b sets the ref the MERGED column checks against (e.g. origin/integration).
#   Without it the base is origin/HEAD, then origin/main, then origin/master.
#   origin/HEAD is the remote's default branch, not necessarily the branch PRs
#   merge into; pass -b when they differ.
#
# BUCKET=safe requires all of: no tracked edits, no open/draft PR, no recent
# chat, a merged state (ancestry or PR merged), and no commits that exist only
# locally. A branch that is ahead of its remote or has no remote ref is never
# safe, even when merged: the merge may not have been the one that counted.
# Those rows get BUCKET=review plus a warn line naming the reason.
set -u

base=""
while [ $# -gt 0 ]; do
	case "$1" in
	-b|--base) [ $# -ge 2 ] || { echo "error: $1 needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
	-h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	-*) echo "error: unknown option: $1" >&2; exit 2 ;;
	*) break ;;
	esac
done

prs=$(mktemp) || exit 1
wts=$(mktemp) || exit 1
raw_wts=$(mktemp) || exit 1
cleanup() { rm -f "$prs" "$wts" "$raw_wts"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# Portable file mtime in epoch seconds: GNU first, then BSD.
file_mtime() {
	stat -c %Y "$1" 2>/dev/null && return 0
	stat -f %m "$1" 2>/dev/null && return 0
	return 1
}

# Portable epoch -> YYYY-MM-DD: GNU date first, then BSD.
format_date() {
	date -d "@$1" '+%Y-%m-%d' 2>/dev/null && return 0
	date -r "$1" '+%Y-%m-%d' 2>/dev/null
}

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git repo: $repo" >&2; exit 1; }

# Worktree paths are NUL-separated so names with spaces or tabs survive.
# Main worktree is the first entry; everything else is a candidate.
# Older Git without -z falls back to a line-based read, which loses paths that
# contain newlines but keeps spaces intact.
if ! git worktree list --porcelain -z > "$raw_wts" 2>/dev/null; then
	git worktree list --porcelain 2>/dev/null \
		| awk '/^worktree /{printf "%s%c", $0, 0}' > "$raw_wts"
fi
main_wt=""
while IFS= read -r -d '' field; do
	case "$field" in
	"worktree "*)
		wt_path="${field#worktree }"
		if [ -z "$main_wt" ]; then
			main_wt="$wt_path"
		else
			printf '%s\0' "$wt_path" >> "$wts"
		fi ;;
	esac
done < "$raw_wts"
[ -n "$main_wt" ] || { echo "error: git worktree list returned nothing" >&2; exit 1; }

if [ -z "$base" ]; then
	for cand in "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
		[ -n "$cand" ] && git rev-parse --verify --quiet "$cand^{commit}" >/dev/null && { base="$cand"; break; }
	done
	[ -z "$base" ] && { echo "error: no base ref (origin/HEAD, origin/main, origin/master all missing); pass -b <ref>" >&2; exit 1; }
	echo "warn: no -b given; MERGED checks against $base" >&2
fi

# The base drives the merge check. The fetch is best-effort (stale is fine for
# a first pass) and runs before the check, since -b may name a branch not
# fetched yet. The explicit refspec creates it even in a single-branch clone.
case "$base" in
origin/*) git fetch origin "+refs/heads/${base#origin/}:refs/remotes/$base" --quiet 2>/dev/null \
	|| echo "warn: could not fetch $base; merged column may be stale" >&2 ;;
esac
git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || { echo "error: base ref not found: $base" >&2; exit 1; }

# PR state by branch, fetched once as [{number, state, head}] with a lowercase
# state. Origin when its CLI can read this repo's PRs, otherwise gh. Empty when
# neither can.
: > "$prs"
if command -v origin >/dev/null 2>&1 \
	&& raw=$(origin pr list --author "@me" --state all --limit 1000 \
		--json number,status,headRef 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: ((.status // "unknown") | ascii_downcase), head: .headRef}]' > "$prs" 2>/dev/null
elif raw=$(gh pr list --author "@me" --state all --limit 1000 \
	--json number,state,headRefName 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: ((.state // "unknown") | ascii_downcase), head: .headRefName}]' > "$prs" 2>/dev/null
fi
[ -s "$prs" ] || echo "[]" > "$prs"

# Session dir: ~/.dsh/sessions/--<slugified-repo-path>--.
slug=$(printf '%s' "$main_wt" | sed 's#^/##; s#/#-#g')
sessions="$HOME/.dsh/sessions/--$slug--"
now=$(date +%s)

echo "# base: $base"
printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

while IFS= read -r -d '' wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk 'NR == 1 {print $1}')
	[ -n "$size" ] || size="?"
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age="?"
	if [ -n "$head_ts" ] && [ "$head_ts" -gt 0 ] 2>/dev/null; then
		age="$(( (now - head_ts) / 86400 ))d"
	fi

	# Squash-merged branches are not ancestors of the base, so PR state is the
	# real signal; merge-base only catches fast-forward/rebase merges.
	if [ -n "$head" ] && git merge-base --is-ancestor "$head" "$base" 2>/dev/null; then
		merged=YES
	else
		merged=no
	fi

	# Distinguish real WIP (tracked edits) from disposable untracked scratch.
	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
	elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
		dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
	else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	unpushed=no
	if [ -z "$branch" ]; then
		remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		ahead=$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)
		behind=$(git -C "$wt" rev-list --count "HEAD..origin/$branch" 2>/dev/null)
		case "$ahead" in
		""|*[!0-9]*) remote=unknown; unpushed=yes ;;
		0) case "$behind" in
			0) remote=pushed ;;
			""|*[!0-9]*) remote=unknown ;;
			*) remote="behind:$behind" ;;
			esac ;;
		*) remote="ahead:$ahead"; unpushed=yes ;;
		esac
	else
		remote=no-remote
		unpushed=yes
	fi

	pr=""
	pr_state=""
	if [ -n "$branch" ]; then
		# One branch can have several PRs over its life. Report the most
		# actionable state first (a live PR hides nothing by being listed
		# under an older merged one) and the newest number within a state.
		pr=$(jq -r --arg b "$branch" '
			[.[] | select(.head == $b)]
			| sort_by((if .state == "open" or .state == "draft" then 0
				elif .state == "merged" then 1
				else 2 end), -(.number))
			| .[0]
			| if . == null then "" else "#\(.number)/\(.state)" end
		' "$prs" 2>/dev/null)
	fi
	case "$pr" in
	*"/merged") pr_state=merged ;;
	*"/open"|*"/draft") pr_state=open ;;
	*"/closed") pr_state=closed ;;
	esac
	[ -z "$pr" ] && pr="-"

	# Most recent session that operated in this worktree. Match path
	# followed by "/" or a quote so glint-482 does not match glint-482-r37.
	# Session files are zstd streams, so decode before the text search, and
	# walk newest first so the common case stops after a few files.
	last="-"; last_ts=0
	if [ -d "$sessions" ] && command -v zstd >/dev/null 2>&1; then
		f=$(find "$sessions" -name 'session.v4.jsonl.zstd' -type f -print0 2>/dev/null \
			| while IFS= read -r -d '' file; do
				ts=$(file_mtime "$file" 2>/dev/null) || continue
				printf '%s\t%s\n' "$ts" "$file"
			done | sort -rn \
			| while IFS="$(printf '\t')" read -r ts file; do
				if zstd -dc "$file" 2>/dev/null | grep -qF -e "${wt}/" -e "${wt}\""; then
					printf '%s\t%s\n' "$ts" "$file"; break
				fi
			done | head -1)
		if [ -n "$f" ]; then
			last_ts=$(printf '%s' "$f" | cut -f1)
			case "$last_ts" in ""|*[!0-9]*) last_ts=0 ;; esac
			if [ "$last_ts" -gt 0 ] 2>/dev/null; then
				last=$(format_date "$last_ts" 2>/dev/null)
				[ -n "$last" ] || last="-"
			fi
		fi
	fi
	recent=no
	if [ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ]; then
		recent=yes
	fi

	# The merged state is either ancestry or a merged PR; a PR that was closed
	# without merging proves nothing and is not enough to release anything.
	released=no
	if [ "$merged" = YES ] || [ "$pr_state" = merged ]; then
		released=yes
	fi

	case "$dirty" in
	wip:*) bucket=hold-wip ;;
	*)
		if [ "$pr_state" = open ]; then
			bucket=hold-open-pr
		elif [ "$recent" = yes ]; then
			bucket=verify-recent-chat
		elif [ "$released" = yes ] && [ "$unpushed" = no ]; then
			bucket=safe
		else
			bucket=review
			if [ "$unpushed" = yes ]; then
				printf 'warn: not safe: %s has commits only on this machine (remote=%s)\n' "$wt" "$remote" >&2
			elif [ "$pr_state" = closed ]; then
				printf 'warn: not safe: %s has PR %s closed without merging\n' "$wt" "$pr" >&2
			fi
		fi ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done < "$wts" | sort -t"$(printf '\t')" -k1,1 -rh
