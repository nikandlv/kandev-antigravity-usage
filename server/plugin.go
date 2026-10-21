package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// Action keys declared in manifest.yaml
const (
	ActionProfilesList  = "profiles.list"
	ActionProfilesUsage = "profiles.usage"
	WebhookUsage        = "usage"
)

// ProfileInfo represents an Antigravity agent profile found under ~/.agx
type ProfileInfo struct {
	InstanceName string `json:"instance_name"`
	AgentID      string `json:"agent_id,omitempty"`
	Role         string `json:"role,omitempty"`
	Avatar       string `json:"avatar,omitempty"`
	HomeDir      string `json:"home_dir"`
}

// BucketUsage represents a single quota bucket (e.g. weekly or 5-hour limit).
type BucketUsage struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	Description       string  `json:"description,omitempty"`
	Window            string  `json:"window"`
	RemainingFraction float64 `json:"remaining_fraction"`
	RemainingPercent  int     `json:"remaining_percent"`
	ResetTime         string  `json:"reset_time,omitempty"`
	Disabled          bool    `json:"disabled,omitempty"`
}

// GroupUsage represents a model group (e.g. Gemini Models, Claude & GPT models).
type GroupUsage struct {
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	Buckets     []BucketUsage `json:"buckets"`
}

// ProfileUsage holds the full usage and quota information for an agent profile.
type ProfileUsage struct {
	Profile     ProfileInfo  `json:"profile"`
	Groups      []GroupUsage `json:"groups"`
	Description string       `json:"description,omitempty"`
	FetchedAt   string       `json:"fetched_at"`
	Error       string       `json:"error,omitempty"`
}

// AggregateBucket summarizes quotas across all available profiles.
type AggregateBucket struct {
	GroupName    string  `json:"group_name"`
	Window       string  `json:"window"`
	BucketName   string  `json:"bucket_name"`
	Instances    int     `json:"instances"`
	AvgRemaining float64 `json:"avg_remaining"`
	AvgPercent   int     `json:"avg_percent"`
}

// UsageResponse is the full payload returned to the UI and webhooks.
type UsageResponse struct {
	Profiles   []ProfileUsage    `json:"profiles"`
	Aggregates []AggregateBucket `json:"aggregates"`
	FetchedAt  string            `json:"fetched_at"`
	Error      string            `json:"error,omitempty"`
}

// ProfileListResponse is returned for ActionProfilesList.
type ProfileListResponse struct {
	Profiles []ProfileInfo `json:"profiles"`
	Error    string        `json:"error,omitempty"`
}

// commandRunner abstracts CLI execution for testing.
type commandRunner func(ctx context.Context, name string, args []string, env []string) ([]byte, error)

func defaultCommandRunner(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	return cmd.Output()
}

type antigravityUsagePlugin struct {
	pluginsdk.UnimplementedPlugin
	runner commandRunner
}

var (
	_ pluginsdk.Plugin        = (*antigravityUsagePlugin)(nil)
	_ pluginsdk.ActionHandler = (*antigravityUsagePlugin)(nil)
)

func newAntigravityUsagePlugin() *antigravityUsagePlugin {
	return &antigravityUsagePlugin{
		runner: defaultCommandRunner,
	}
}

// HandleAction dispatches declared browser actions.
func (p *antigravityUsagePlugin) HandleAction(ctx context.Context, req *pluginsdk.PluginActionRequest) (*pluginsdk.PluginActionResponse, error) {
	if req == nil {
		return nil, errors.New("antigravity-usage: action request is required")
	}

	agxDir := p.resolveAgxDir(ctx)
	agyBin := p.resolveAgyBin(ctx)

	switch req.ActionKey {
	case ActionProfilesList:
		profiles, err := p.discoverProfiles(agxDir)
		if err != nil {
			respBytes, _ := json.Marshal(ProfileListResponse{Error: err.Error()})
			return &pluginsdk.PluginActionResponse{
				Status: 200,
				Body:   respBytes,
			}, nil
		}
		respBytes, _ := json.Marshal(ProfileListResponse{Profiles: profiles})
		return &pluginsdk.PluginActionResponse{
			Status: 200,
			Body:   respBytes,
		}, nil

	case ActionProfilesUsage:
		var filter struct {
			Instance string `json:"instance"`
		}
		if len(req.Body) > 0 {
			_ = json.Unmarshal(req.Body, &filter)
		}

		usageResp := p.fetchAllUsages(ctx, agxDir, agyBin, filter.Instance)
		respBytes, err := json.Marshal(usageResp)
		if err != nil {
			return nil, fmt.Errorf("marshalling usage response: %w", err)
		}
		return &pluginsdk.PluginActionResponse{
			Status: 200,
			Body:   respBytes,
		}, nil

	default:
		return nil, fmt.Errorf("antigravity-usage: unknown action %q", req.ActionKey)
	}
}

// HandleWebhook dispatches webhooks declared in manifest.yaml.
func (p *antigravityUsagePlugin) HandleWebhook(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	if req == nil {
		return nil, errors.New("antigravity-usage: webhook request is required")
	}

	switch req.WebhookKey {
	case WebhookUsage:
		agxDir := p.resolveAgxDir(ctx)
		agyBin := p.resolveAgyBin(ctx)
		usageResp := p.fetchAllUsages(ctx, agxDir, agyBin, "")
		body, err := json.Marshal(usageResp)
		if err != nil {
			return nil, fmt.Errorf("marshalling usage response: %w", err)
		}
		return &pluginsdk.WebhookResponse{
			Status: 200,
			Body:   body,
		}, nil

	default:
		return &pluginsdk.WebhookResponse{
			Status: 404,
			Body:   []byte(`{"error":"webhook not found"}`),
		}, nil
	}
}

// resolveAgxDir determines the path to ~/.agx.
func (p *antigravityUsagePlugin) resolveAgxDir(ctx context.Context) string {
	if host := p.Host(); host != nil {
		if cfg, err := host.GetConfig(ctx); err == nil {
			if dir, ok := cfg["agx_dir"].(string); ok && strings.TrimSpace(dir) != "" {
				return expandPath(strings.TrimSpace(dir))
			}
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	return filepath.Join(home, ".agx")
}

// resolveAgyBin determines the path to the agy binary.
func (p *antigravityUsagePlugin) resolveAgyBin(ctx context.Context) string {
	if host := p.Host(); host != nil {
		if cfg, err := host.GetConfig(ctx); err == nil {
			if bin, ok := cfg["agy_binary"].(string); ok && strings.TrimSpace(bin) != "" {
				return expandPath(strings.TrimSpace(bin))
			}
		}
	}

	// Auto-detect candidates
	candidates := []string{
		"/opt/homebrew/bin/agy",
		"/usr/local/bin/agy",
		filepath.Join(os.Getenv("HOME"), ".bin", "agy"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}

	if lookPath, err := exec.LookPath("agy"); err == nil {
		return lookPath
	}

	return "agy"
}

func expandPath(p string) string {
	if strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		if home == "" {
			home = os.Getenv("HOME")
		}
		return filepath.Join(home, p[2:])
	}
	return os.ExpandEnv(p)
}

// discoverProfiles finds all profile directories in agxDir.
func (p *antigravityUsagePlugin) discoverProfiles(agxDir string) ([]ProfileInfo, error) {
	entries, err := os.ReadDir(agxDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("agx directory does not exist: %s", agxDir)
		}
		return nil, fmt.Errorf("reading agx directory: %w", err)
	}

	var profiles []ProfileInfo
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		instanceName := entry.Name()
		profileDir := filepath.Join(agxDir, instanceName)

		profile := ProfileInfo{
			InstanceName: instanceName,
			HomeDir:      profileDir,
			Role:         fmt.Sprintf("%s Specialist", instanceName),
		}

		// Read board_agent.json if present
		agentJSONPath := filepath.Join(profileDir, "board_agent.json")
		if data, err := os.ReadFile(agentJSONPath); err == nil {
			var parsed struct {
				InstanceName string `json:"instance_name"`
				AgentID      string `json:"agent_id"`
				Role         string `json:"role"`
				Avatar       string `json:"avatar"`
			}
			if err := json.Unmarshal(data, &parsed); err == nil {
				if parsed.InstanceName != "" {
					profile.InstanceName = parsed.InstanceName
				}
				if parsed.AgentID != "" {
					profile.AgentID = parsed.AgentID
				}
				if parsed.Role != "" {
					profile.Role = parsed.Role
				}
				if parsed.Avatar != "" {
					profile.Avatar = parsed.Avatar
				}
			}
		}

		profiles = append(profiles, profile)
	}

	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].InstanceName < profiles[j].InstanceName
	})

	return profiles, nil
}

type agyRawBucket struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	Description       string  `json:"description"`
	Window            string  `json:"window"`
	RemainingFraction float64 `json:"remaining_fraction"`
	ResetTime         string  `json:"reset_time"`
	Disabled          bool    `json:"disabled"`
}

type agyRawGroup struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Buckets     []agyRawBucket `json:"buckets"`
}

type agyRawData struct {
	Description string        `json:"description"`
	Groups      []agyRawGroup `json:"groups"`
}

type agyRawCommand struct {
	Name string     `json:"name"`
	Data agyRawData `json:"data"`
}

type agyRawOutput struct {
	Status  string        `json:"status"`
	Command agyRawCommand `json:"command"`
	Error   string        `json:"error"`
}

// fetchUsageForProfile queries agy for a single profile.
func (p *antigravityUsagePlugin) fetchUsageForProfile(ctx context.Context, agyBin string, profile ProfileInfo) ProfileUsage {
	fetchedAt := time.Now().UTC().Format(time.RFC3339)
	result := ProfileUsage{
		Profile:   profile,
		FetchedAt: fetchedAt,
	}

	env := cleanEnvForProfile(profile.HomeDir)
	args := []string{"-p", "/usage", "--disable-slash-commands=false", "--output-format", "json"}

	// 20-second timeout per individual query
	queryCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	output, err := p.runner(queryCtx, agyBin, args, env)
	if err != nil {
		result.Error = fmt.Sprintf("failed running %s for %s: %v", agyBin, profile.InstanceName, err)
		return result
	}

	var raw agyRawOutput
	if err := json.Unmarshal(output, &raw); err != nil {
		result.Error = fmt.Sprintf("invalid JSON output from agy: %v", err)
		return result
	}

	if raw.Error != "" {
		result.Error = raw.Error
		return result
	}

	result.Description = raw.Command.Data.Description
	for _, group := range raw.Command.Data.Groups {
		g := GroupUsage{
			Name:        group.Name,
			Description: group.Description,
		}
		for _, b := range group.Buckets {
			remPct := int(math.Round(b.RemainingFraction * 100))
			if b.Disabled {
				// When disabled due to quota depletion, indicate 0%
				remPct = 0
			}
			g.Buckets = append(g.Buckets, BucketUsage{
				ID:                b.ID,
				Name:              b.Name,
				Description:       b.Description,
				Window:            b.Window,
				RemainingFraction: b.RemainingFraction,
				RemainingPercent:  remPct,
				ResetTime:         b.ResetTime,
				Disabled:          b.Disabled,
			})
		}
		result.Groups = append(result.Groups, g)
	}

	return result
}

// cleanEnvForProfile prepares environment variables for agy execution.
func cleanEnvForProfile(homeDir string) []string {
	var env []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "HOME=") {
			continue
		}
		env = append(env, e)
	}
	env = append(env, "HOME="+homeDir)
	return env
}

// fetchAllUsages retrieves usage for all or filtered profiles.
func (p *antigravityUsagePlugin) fetchAllUsages(ctx context.Context, agxDir, agyBin string, filterInstance string) UsageResponse {
	fetchedAt := time.Now().UTC().Format(time.RFC3339)
	profiles, err := p.discoverProfiles(agxDir)
	if err != nil {
		return UsageResponse{
			FetchedAt: fetchedAt,
			Error:     err.Error(),
		}
	}

	if filterInstance != "" {
		var matched []ProfileInfo
		for _, prof := range profiles {
			if strings.EqualFold(prof.InstanceName, filterInstance) {
				matched = append(matched, prof)
				break
			}
		}
		if len(matched) == 0 {
			return UsageResponse{
				FetchedAt: fetchedAt,
				Error:     fmt.Sprintf("profile %q not found", filterInstance),
			}
		}
		profiles = matched
	}

	// Fetch concurrently
	results := make([]ProfileUsage, len(profiles))
	var wg sync.WaitGroup

	// Concurrency limiter
	sem := make(chan struct{}, 6)

	for i, prof := range profiles {
		wg.Add(1)
		go func(idx int, pi ProfileInfo) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			results[idx] = p.fetchUsageForProfile(ctx, agyBin, pi)
		}(i, prof)
	}

	wg.Wait()

	aggregates := computeAggregates(results)

	return UsageResponse{
		Profiles:   results,
		Aggregates: aggregates,
		FetchedAt:  fetchedAt,
	}
}

// computeAggregates calculates group/window average percentages.
func computeAggregates(profiles []ProfileUsage) []AggregateBucket {
	type bucketKey struct {
		GroupName  string
		Window     string
		BucketName string
	}

	type bucketStat struct {
		sumFraction float64
		count       int
	}

	stats := make(map[bucketKey]*bucketStat)
	var orderedKeys []bucketKey

	for _, pu := range profiles {
		if pu.Error != "" {
			continue
		}
		for _, g := range pu.Groups {
			for _, b := range g.Buckets {
				key := bucketKey{
					GroupName:  g.Name,
					Window:     b.Window,
					BucketName: b.Name,
				}
				stat, exists := stats[key]
				if !exists {
					stat = &bucketStat{}
					stats[key] = stat
					orderedKeys = append(orderedKeys, key)
				}
				stat.count++
				if b.Disabled {
					stat.sumFraction += 0.0
				} else {
					stat.sumFraction += b.RemainingFraction
				}
			}
		}
	}

	var aggregates []AggregateBucket
	for _, key := range orderedKeys {
		stat := stats[key]
		avg := 0.0
		avgPct := 0
		if stat.count > 0 {
			avg = stat.sumFraction / float64(stat.count)
			avgPct = int(math.Round(avg * 100))
		}
		aggregates = append(aggregates, AggregateBucket{
			GroupName:    key.GroupName,
			Window:       key.Window,
			BucketName:   key.BucketName,
			Instances:    stat.count,
			AvgRemaining: avg,
			AvgPercent:   avgPct,
		})
	}

	return aggregates
}
