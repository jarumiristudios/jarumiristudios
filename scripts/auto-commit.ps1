$ErrorActionPreference = "Stop"
Set-Location "F:\fatshew\projects\jarumiri_studios"

$logFile = Join-Path $PSScriptRoot "auto-commit.log"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$prompt = @'
Automated periodic commit for the jarumiri_studios project. The user has already authorized this to run unattended, including pushing to origin -- do not ask for confirmation, just do the task.

1. Run `git status` in the project root.
2. If there are no staged/unstaged changes and no untracked files, stop -- do nothing.
3. Otherwise:
   a. Run `git diff` and `git status` to understand what changed.
   b. Stage relevant files (skip anything that looks like a secret/credential/.env file -- warn instead of staging those).
   c. Write a concise, descriptive commit message (1-3 lines) based on the actual diff content, not a generic placeholder. Match the repo's existing commit style where discernible from `git log`.
   d. Commit, ending the message with:
      Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
   e. Push to origin on the current branch. No force push.
4. Do not amend, rewrite history, or skip hooks (--no-verify).
5. If push fails (e.g. remote diverged), do not force push -- report it and stop.
6. Keep the final response brief: what was committed/pushed, or "no changes to commit."
'@

Add-Content -Path $logFile -Value "----- Run started $timestamp -----"

try {
    $output = claude -p $prompt --allowedTools "Bash(git *)" --output-format text 2>&1
    Add-Content -Path $logFile -Value $output
} catch {
    Add-Content -Path $logFile -Value "ERROR: $_"
}

Add-Content -Path $logFile -Value "----- Run finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -----`n"
