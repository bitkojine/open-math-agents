#!/usr/bin/env bash
# GitHub labels keep failed merges discoverable across runner jobs. A label only selects
# candidates. The merger still checks the workflow run and revalidates the exact PR head.
MERGE_RETRY_LABEL=oma-merge-pending
MERGE_HANDOFF_LABEL=oma-merge-needs-maintainer

has_merge_label() {
  jq -e --arg label "$1" 'any(.labels[]?; .name == $label)' pr.json >/dev/null
}

add_merge_label() {
  local pr="$1" label="$2" description="$3" result
  local endpoint="repos/$REPO/issues/$pr/labels"
  if result=$(gh api "$endpoint" -f "labels[]=$label" 2>&1); then return 0; fi
  if ! grep -Eq 'HTTP (404|422)' <<< "$result"; then
    printf '%s\n' "$result" >&2
    return 1
  fi
  # Lazily create the label. Another merger may have created it in the meantime.
  gh api "repos/$REPO/labels" -f "name=$label" -f color=b60205 -f "description=$description" >/dev/null 2>&1 || true
  gh api "$endpoint" -f "labels[]=$label" >/dev/null
}

clear_merge_retry() {
  gh api -X DELETE "repos/$REPO/issues/$1/labels/$MERGE_RETRY_LABEL" >/dev/null
}

discover_merge_retries() {
  local run_fields="$1" prs pr details sha runs
  prs=$(gh api --paginate "repos/$REPO/issues?state=open&labels=$MERGE_RETRY_LABEL&per_page=100" \
    --jq '.[] | select(.pull_request != null) | .number') || return 1
  while IFS= read -r pr; do
    [[ "$pr" =~ ^[0-9]+$ ]] || continue
    details=$(gh api "repos/$REPO/pulls/$pr") || continue
    sha=$(jq -er --arg handoff "$MERGE_HANDOFF_LABEL" '
      select(.state == "open" and .base.ref == "main")
      | select(all(.labels[]?; .name != $handoff)) | .head.sha' <<< "$details") || continue
    [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || continue
    runs=$(gh api "repos/$REPO/actions/workflows/check-proof.yml/runs?event=pull_request&head_sha=$sha&per_page=100") || continue
    jq -r --arg sha "$sha" --arg title "check-proof #$pr" '
      [.workflow_runs[] | select(.event == "pull_request" and .head_sha == $sha and .display_title == $title)]
      | max_by([.run_number, .run_attempt])
      | select(.status == "completed" and .conclusion == "success")
      | ('"$run_fields"') + "\tremerge"' <<< "$runs"
  done <<< "$prs"
}
