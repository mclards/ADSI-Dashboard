# sync-agents.ps1
# Syncs .claude/agents/*.md → .codex/agents/*.toml
# Run this after updating any Claude Code agent
# Usage: .\sync-agents.ps1

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$CLAUDE_AGENTS = Join-Path $ROOT ".claude\agents"
$CODEX_AGENTS  = Join-Path $ROOT ".codex\agents"

# Model mapping — Claude model names → Codex model names
$MODEL_MAP = @{
    "opus"   = "gpt-5.4"
    "sonnet" = "gpt-5.4-mini"
    "haiku"  = "gpt-5.4-mini"
}

# Reasoning effort mapping
$EFFORT_MAP = @{
    "opus"   = "high"
    "sonnet" = "medium"
    "haiku"  = "low"
}

# Sandbox mode mapping based on tools
function Get-SandboxMode($tools) {
    if ($tools -match "Write|Edit|Bash") {
        return "workspace-write"
    }
    return "read-only"
}

if (-not (Test-Path $CODEX_AGENTS)) {
    New-Item -ItemType Directory -Path $CODEX_AGENTS | Out-Null
}

$agents = Get-ChildItem -Path $CLAUDE_AGENTS -Filter "*.md"

foreach ($agent in $agents) {
    $content = Get-Content $agent.FullName -Raw
    $name    = $agent.BaseName

    # Parse frontmatter
    if ($content -match "(?s)^---\s*\n(.+?)\n---") {
        $frontmatter = $matches[1]
    } else {
        Write-Warning "No frontmatter found in $($agent.Name) — skipping"
        continue
    }

    # Extract fields
    $agentName   = if ($frontmatter -match "name:\s*(.+)") { $matches[1].Trim() } else { $name }
    $description = if ($frontmatter -match "description:\s*(.+)") { $matches[1].Trim() } else { "" }
    $model       = if ($frontmatter -match "model:\s*(.+)") { $matches[1].Trim() } else { "sonnet" }
    $tools       = if ($frontmatter -match "tools:\s*(.+)") { $matches[1].Trim() } else { "Read, Grep" }

    # Extract system prompt (everything after frontmatter)
    $systemPrompt = $content -replace "(?s)^---.*?---\s*\n", ""
    $systemPrompt = $systemPrompt.Trim()

    # Map to Codex equivalents
    $codexModel  = if ($MODEL_MAP.ContainsKey($model)) { $MODEL_MAP[$model] } else { "gpt-5.4-mini" }
    $effort      = if ($EFFORT_MAP.ContainsKey($model)) { $EFFORT_MAP[$model] } else { "medium" }
    $sandbox     = Get-SandboxMode $tools

    # Escape triple-quotes in system prompt for TOML
    $escapedPrompt = $systemPrompt -replace '"""', '\"\"\"'

    # Build TOML
    $toml = @"
name = "$agentName"
description = "$description"
model = "$codexModel"
model_reasoning_effort = "$effort"
sandbox_mode = "$sandbox"
developer_instructions = """
$escapedPrompt
"""
"@

    $outPath = Join-Path $CODEX_AGENTS "$name.toml"
    $toml | Set-Content -Path $outPath -Encoding UTF8
    Write-Host "Synced: $($agent.Name) → $name.toml"
}

# Also sync SKILL.md from .claude/skills to .agents/skills
$CLAUDE_SKILL = Join-Path $ROOT ".claude\skills\adsi-dashboard"
$AGENTS_SKILL = Join-Path $ROOT ".agents\skills\adsi-dashboard"

if (Test-Path $CLAUDE_SKILL) {
    if (-not (Test-Path $AGENTS_SKILL)) {
        New-Item -ItemType Directory -Path $AGENTS_SKILL -Force | Out-Null
    }
    Copy-Item -Path "$CLAUDE_SKILL\*" -Destination $AGENTS_SKILL -Recurse -Force
    Write-Host "Synced: .claude/skills/adsi-dashboard → .agents/skills/adsi-dashboard"
}

Write-Host ""
Write-Host "Sync complete — $($agents.Count) agent(s) synced to .codex/agents/"
Write-Host "Run this script after any agent update to keep Codex in parity."
