# kandev-antigravity-usage

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](manifest.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Kandev Minimum Version](https://img.shields.io/badge/kandev-%3E%3D0.86.0-green.svg)](manifest.yaml)

A [kandev](https://github.com/kdlbs/kandev) **native-UI plugin** that monitors Antigravity agent quotas, limits, and reset times across multi-account profiles (`~/.agx`).

The plugin discovers configured agent instances, queries quota status concurrently via the `agy` CLI with per-profile environment isolation, and surfaces live visual gauges, aggregate health stats, and detailed model usage tables directly within the Kandev workspace.

---

## Features

- **Multi-Account Profile Discovery**  
  Scans `~/.agx` (or custom directory configured in settings) to discover all agent profiles. Automatically parses profile metadata (`board_agent.json`) including instance name, agent ID, role, and avatar.

- **Kandev Profile Toggle**  
  Selectively enable or disable individual profiles for Kandev. Disabled profiles display a "Disabled" badge and are bypassed during batch quota runs to save resources.

- **Smart 10-Minute Caching**  
  Maintains an in-memory 10-minute cache with relative age badges (`Cached (10m TTL) • 2m ago`), preventing excessive CLI executions while supporting immediate manual cache bypass.

- **Real-Time Quota Polling & Single-Agent Refresh**  
  Queries the `agy` CLI (`agy -p /usage --disable-slash-commands=false --output-format json`) concurrently with worker pool concurrency limiting (up to 6 parallel queries) and 20-second per-query timeouts. Each query runs with isolated environment variables (`HOME=<profile_dir>`). Supports full refresh as well as single-profile instant refresh.

- **Aggregated Capacity & Health Summaries**  
  Computes average remaining quota percentages and instance counts across all profiles for each model group and window (e.g. Gemini Weekly, Gemini 5-hour, Claude & GPT Weekly, Claude & GPT 5-hour).

- **Status & Reset Countdown Indicators**  
  Calculates remaining quota fractions and assigns color-coded health statuses:
  - 🟢 **Healthy** (≥ 60% remaining)
  - 🔵 **Moderate** (25% – 59% remaining)
  - 🟡 **Low** (< 25% remaining)
  - 🔴 **Depleted** (0% remaining or quota disabled)  
  Displays humanized countdowns to quota resets (e.g., `in 3d 12h`, `in 2h 45m`, or `resets soon`).

- **Native Kandev SPA UI**  
  Renders directly inside the Kandev React application shell without iframes:
  - **Dedicated Route (`/antigravity-usage`)**: Full dashboard showing aggregate quota cards, profile cards, and tabular metrics.
  - **Sidebar Navigation**: Adds an **Antigravity Usage** entry under the main sidebar navigation with a gauge icon.
  - **Chat Composer Toolbar Action**: A dedicated toolbar button (`antigravity-usage-chat-action`) right in the chat composer to quickly check quotas mid-conversation.
  - **Dual View Modes**: Switch seamlessly between interactive **Cards** grid and dense **Table** views.
  - **Live Search & Filter**: Filter profiles in real-time by profile name or role.
  - **Manual Refresh**: On-demand quota refresh with visual spinner and toast status notifications (`host.toast`).

- **Backend Actions & Webhooks**  
  - Action `profiles.list`: Lists discovered Antigravity agent profiles.
  - Action `profiles.usage`: Retrieves full quota metrics, optionally filtering by specific instance name or a list of enabled instances (`instances` / `enabled_instances`).
  - Webhook `/webhooks/usage`: Authenticated `POST` webhook returning JSON usage data for external automation and scripts.

---

## User Interface Overview

### 1. Antigravity Usage Dashboard (`/antigravity-usage`)
Accessible from the sidebar navigation ("Antigravity Usage") or by direct URL navigation.

- **Aggregate Overview**: Top summary cards displaying average availability across all discovered profiles for key model windows:
  - Gemini Models (Weekly & 5-hour windows)
  - Claude & GPT Models (Weekly & 5-hour windows)
- **Profile Cards**: Detailed card for each profile showing:
  - Agent avatar, instance name, and assigned role.
  - Profile enable/disable switch for Kandev.
  - Single-profile refresh button.
  - Progress bars with exact remaining percentages for each model group.
  - Reset countdowns and status badges.
- **Table View**: Dense tabular display comparing all profiles and model buckets side-by-side, with individual refresh buttons.

### 2. Chat Composer Toolbar Action
Located alongside model selection and composer controls in Kandev chat sessions, providing instant one-click access to agent quotas without losing your current task context.

---

## Configuration

Configure the plugin in Kandev at **Settings > Plugins > Antigravity Usage**.

| Setting | Manifest Key | Default | Description |
| :--- | :--- | :--- | :--- |
| **Agx Profiles Directory** | `agx_dir` | `""` (resolves to `~/.agx`) | Absolute or `~/` path to the `.agx` multi-account directory. |
| **Agy Binary** | `agy_binary` | `""` (auto-detected) | Path to the `agy` CLI binary. Auto-detects in `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, `~/.bin/agy`, or `$PATH`. |

---

## How It Works

```mermaid
flowchart TD
    subgraph Kandev SPA
        UI[UI Bundle: ui/bundle.js]
        Chat[Chat Toolbar Action]
        Nav[Sidebar Nav Item: /antigravity-usage]
        Cache[10m In-Memory Cache]
    end

    subgraph Plugin Backend (gRPC Subprocess)
        Handler[Action & Webhook Handler]
        Discover[Profile Discovery Engine]
        Runner[Concurrent agy CLI Runner]
        Agg[Aggregate Calculator]
    end

    subgraph Local System
        AGX["~/.agx/ Profiles<br/>(board_agent.json)"]
        AGY["agy CLI<br/>(HOME=/profile)"]
    end

    Nav --> UI
    Chat -->|Navigate| UI
    UI <--> Cache
    UI -->|profiles.usage action| Handler
    Handler --> Discover
    Discover --> AGX
    Handler --> Runner
    Runner -->|HOME=profile_dir| AGY
    Runner --> Agg
    Agg --> Handler
    Handler -->|UsageResponse JSON| UI
```

1. **Host Integration**: Kandev launches the platform binary declared in `manifest.yaml` via HashiCorp `go-plugin` over private gRPC.
2. **Profile Discovery**: The plugin inspects subdirectories under `agx_dir` (default `~/.agx`), reading optional `board_agent.json` files for agent display names and roles.
3. **Isolated CLI Invocations**: For each profile, the plugin runs `agy -p /usage --disable-slash-commands=false --output-format json` with `HOME` set to the profile's home directory.
4. **Aggregation & Normalization**: Raw bucket fractions are converted to rounded percentages, reset timestamps are structured, and average availability is calculated across all profiles.
5. **UI Rendering**: The frontend bundle receives the payload via `host.api.invokeAction("profiles.usage")` (falling back to authenticated webhook if needed) and renders using Kandev's native design system (`host.ui`).

---

## Developing against the SDK

`pkg/pluginsdk` is consumed from the local Kandev checkout. `go.mod` specifies a local replacement:

```go
replace github.com/kandev/kandev => ../kandev/apps/backend
```

This assumes your plugin repository is checked out alongside the `kandev` monorepo:

```
workspace/
├── kandev/                         # https://github.com/kdlbs/kandev
└── nikandlv-kandev-antigravity-usage/   # this plugin repository
```

`.kandev-sdk-ref` pins the exact source revision used for contracts and testing.

---

## Repository Layout

```
manifest.yaml            # Plugin manifest (metadata, actions, webhooks, config_schema)
server/
  main.go                # pluginsdk.Serve entrypoint
  plugin.go              # Profile discovery, agy runner, actions, and aggregates
  plugin_test.go         # Unit tests and mock command runner tests
ui/
  bundle.js              # Native React SPA bundle (Page, Chat Action, Nav Item)
tests/
  ui-action.test.js      # Host Action component integration tests
Makefile                 # Build, package, and verification targets
package.json             # Test runner dependencies
```

---

## Build and Test

### Running Backend Tests
```sh
go test -v ./server/...
```

### Running Frontend Tests
```sh
npm run test:ui
```

### Building the Host Binary
```sh
make build
```
The compiled executable will be placed in `bin/kandev-antigravity-usage`.

---

## Packaging

Package the plugin for distribution:

```sh
# Cross-compile for Linux, macOS, and Windows and create tar.gz package
make package

# Package for host platform only (faster local development)
make package-host

# Verify archive structure, checksums, and manifest declarations
make verify-package
```

Packaging produces `kandev-antigravity-usage-0.2.0.tar.gz` and an internal `checksums.txt`.

---

## Installation

### Via Kandev UI
1. Navigate to **Settings > Plugins** in Kandev.
2. Click **Install plugin**.
3. Choose **Upload file** and select `kandev-antigravity-usage-0.2.0.tar.gz` (or provide a direct download URL).

### Via API / CLI
```sh
curl -F package=@kandev-antigravity-usage-0.2.0.tar.gz \
  http://localhost:<kandev-port>/api/plugins/install
```

Once installed, enable the plugin in **Settings > Plugins**. The **Antigravity Usage** item will appear in your sidebar navigation, and the gauge action icon will be active in the chat composer.

---

## License

[MIT](LICENSE) © [Nikan Dalvand](https://github.com/nikandlv)
