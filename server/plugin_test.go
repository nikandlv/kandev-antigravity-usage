package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

const sampleAgyJSON = `{
  "status": "SUCCESS",
  "command": {
    "name": "usage",
    "data": {
      "description": "Shared weekly and 5-hour limit.",
      "groups": [
        {
          "name": "Gemini Models",
          "description": "Gemini Flash, Gemini Pro",
          "buckets": [
            {
              "id": "gemini-weekly",
              "name": "Weekly Limit Remaining",
              "description": "Weekly refresh",
              "window": "weekly",
              "remaining_fraction": 0.85,
              "reset_time": "2026-10-26T19:07:15Z"
            },
            {
              "id": "gemini-5h",
              "name": "Five Hour Limit Remaining",
              "window": "5h",
              "remaining_fraction": 0.50,
              "reset_time": "2026-10-21T12:26:08Z"
            }
          ]
        },
        {
          "name": "Claude and GPT models",
          "description": "Claude and GPT",
          "buckets": [
            {
              "id": "3p-weekly",
              "name": "Weekly Limit Remaining",
              "window": "weekly",
              "remaining_fraction": 1.0,
              "reset_time": "2026-10-28T09:16:12Z"
            },
            {
              "id": "3p-5h",
              "name": "Five Hour Limit Remaining",
              "window": "5h",
              "remaining_fraction": 1.0,
              "reset_time": "2026-10-21T14:16:12Z"
            }
          ]
        }
      ]
    }
  }
}`

const sampleDisabledAgyJSON = `{
  "status": "SUCCESS",
  "command": {
    "name": "usage",
    "data": {
      "description": "Depleted weekly quota.",
      "groups": [
        {
          "name": "Gemini Models",
          "buckets": [
            {
              "id": "gemini-weekly",
              "name": "Weekly Limit Remaining",
              "window": "weekly",
              "remaining_fraction": 0.0,
              "reset_time": "2026-10-24T06:41:54Z"
            },
            {
              "id": "gemini-5h",
              "name": "Five Hour Limit Remaining",
              "window": "5h",
              "disabled": true,
              "remaining_fraction": 1.0
            }
          ]
        }
      ]
    }
  }
}`

func createMockAgxDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	// Instance 1: kurtis (with board_agent.json)
	kurtisDir := filepath.Join(dir, "kurtis")
	require.NoError(t, os.MkdirAll(kurtisDir, 0755))
	boardData := map[string]string{
		"instance_name": "kurtis",
		"agent_id":      "kurtis-uuid-123",
		"role":          "Autonomous Planner",
		"avatar":        "https://example.com/kurtis.svg",
	}
	bytes, _ := json.Marshal(boardData)
	require.NoError(t, os.WriteFile(filepath.Join(kurtisDir, "board_agent.json"), bytes, 0644))

	// Instance 2: jim (without board_agent.json)
	jimDir := filepath.Join(dir, "jim")
	require.NoError(t, os.MkdirAll(jimDir, 0755))

	// Non-profile hidden dir
	require.NoError(t, os.MkdirAll(filepath.Join(dir, ".hidden"), 0755))

	return dir
}

// fakeHost satisfies pluginsdk.Host for testing.
type fakeHost struct {
	pluginsdk.UnimplementedHostData
	config map[string]any
}

func (h *fakeHost) GetConfig(context.Context) (map[string]any, error) {
	if h.config == nil {
		return map[string]any{}, nil
	}
	return h.config, nil
}

func (h *fakeHost) GetState(context.Context, string, string, string) (map[string]any, bool, error) {
	return nil, false, nil
}
func (h *fakeHost) SetState(context.Context, string, string, string, map[string]any) error {
	return nil
}
func (h *fakeHost) DeleteState(context.Context, string, string, string) error { return nil }
func (h *fakeHost) ListState(context.Context, string, string) ([]pluginsdk.StateEntry, error) {
	return nil, nil
}
func (h *fakeHost) RevealSecret(context.Context, string) (string, error)    { return "", nil }
func (h *fakeHost) GetSecret(context.Context, string) (string, bool, error) { return "", false, nil }
func (h *fakeHost) SetSecret(context.Context, string, string) error         { return nil }
func (h *fakeHost) DeleteSecret(context.Context, string) error              { return nil }
func (h *fakeHost) EmitEvent(context.Context, string, map[string]any) error { return nil }

func TestDiscoverProfiles(t *testing.T) {
	agxDir := createMockAgxDir(t)
	p := newAntigravityUsagePlugin()

	profiles, err := p.discoverProfiles(agxDir)
	require.NoError(t, err)
	require.Len(t, profiles, 2)

	require.Equal(t, "jim", profiles[0].InstanceName)
	require.Equal(t, "jim Specialist", profiles[0].Role)

	require.Equal(t, "kurtis", profiles[1].InstanceName)
	require.Equal(t, "Autonomous Planner", profiles[1].Role)
	require.Equal(t, "kurtis-uuid-123", profiles[1].AgentID)
	require.Equal(t, "https://example.com/kurtis.svg", profiles[1].Avatar)
}

func TestDiscoverProfiles_LiveSystem(t *testing.T) {
	home, _ := os.UserHomeDir()
	agxDir := filepath.Join(home, ".agx")
	if _, err := os.Stat(agxDir); os.IsNotExist(err) {
		t.Skip("~/.agx not found on this machine")
	}

	p := newAntigravityUsagePlugin()
	profiles, err := p.discoverProfiles(agxDir)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(profiles), 6)

	names := make(map[string]bool)
	for _, prof := range profiles {
		names[prof.InstanceName] = true
	}
	for _, expected := range []string{"jim", "keith", "kurtis", "ramon", "rdj", "roy"} {
		require.True(t, names[expected], "profile %s must be discovered", expected)
	}
}

func TestFetchUsageForProfile_Success(t *testing.T) {
	p := newAntigravityUsagePlugin()
	p.runner = func(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
		require.Equal(t, "mock-agy", name)
		require.Contains(t, args, "/usage")
		return []byte(sampleAgyJSON), nil
	}

	profile := ProfileInfo{
		InstanceName: "kurtis",
		HomeDir:      "/tmp/agx/kurtis",
	}

	usage := p.fetchUsageForProfile(context.Background(), "mock-agy", profile)
	require.Empty(t, usage.Error)
	require.Equal(t, "kurtis", usage.Profile.InstanceName)
	require.Len(t, usage.Groups, 2)

	gemini := usage.Groups[0]
	require.Equal(t, "Gemini Models", gemini.Name)
	require.Len(t, gemini.Buckets, 2)
	require.Equal(t, 85, gemini.Buckets[0].RemainingPercent)
	require.Equal(t, 50, gemini.Buckets[1].RemainingPercent)

	claude := usage.Groups[1]
	require.Equal(t, "Claude and GPT models", claude.Name)
	require.Equal(t, 100, claude.Buckets[0].RemainingPercent)
}

func TestFetchUsageForProfile_DisabledBucket(t *testing.T) {
	p := newAntigravityUsagePlugin()
	p.runner = func(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
		return []byte(sampleDisabledAgyJSON), nil
	}

	profile := ProfileInfo{
		InstanceName: "jim",
		HomeDir:      "/tmp/agx/jim",
	}

	usage := p.fetchUsageForProfile(context.Background(), "mock-agy", profile)
	require.Empty(t, usage.Error)
	require.Len(t, usage.Groups, 1)

	gemini := usage.Groups[0]
	require.Len(t, gemini.Buckets, 2)
	require.Equal(t, 0, gemini.Buckets[0].RemainingPercent)
	require.True(t, gemini.Buckets[1].Disabled)
	require.Equal(t, 0, gemini.Buckets[1].RemainingPercent)
}

func TestFetchUsageForProfile_CommandError(t *testing.T) {
	p := newAntigravityUsagePlugin()
	p.runner = func(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
		return nil, errors.New("exec error: process exited 1")
	}

	profile := ProfileInfo{
		InstanceName: "ramon",
		HomeDir:      "/tmp/agx/ramon",
	}

	usage := p.fetchUsageForProfile(context.Background(), "mock-agy", profile)
	require.NotEmpty(t, usage.Error)
	require.Contains(t, usage.Error, "exec error")
}

func TestHandleAction_ProfilesList(t *testing.T) {
	agxDir := createMockAgxDir(t)
	p := newAntigravityUsagePlugin()
	host := &fakeHost{
		config: map[string]any{"agx_dir": agxDir},
	}
	p.SetHost(host)

	resp, err := p.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: ActionProfilesList,
		Context:   pluginsdk.VerifiedActionContext{WorkspaceID: "ws-1"},
	})
	require.NoError(t, err)
	require.Equal(t, 200, resp.Status)

	var listResp ProfileListResponse
	require.NoError(t, json.Unmarshal(resp.Body, &listResp))
	require.Len(t, listResp.Profiles, 2)
}

func TestHandleAction_ProfilesUsage(t *testing.T) {
	agxDir := createMockAgxDir(t)
	p := newAntigravityUsagePlugin()
	host := &fakeHost{
		config: map[string]any{
			"agx_dir":    agxDir,
			"agy_binary": "mock-agy",
		},
	}
	p.SetHost(host)

	p.runner = func(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
		return []byte(sampleAgyJSON), nil
	}

	resp, err := p.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: ActionProfilesUsage,
		Context:   pluginsdk.VerifiedActionContext{WorkspaceID: "ws-1"},
	})
	require.NoError(t, err)
	require.Equal(t, 200, resp.Status)

	var usageResp UsageResponse
	require.NoError(t, json.Unmarshal(resp.Body, &usageResp))
	require.Len(t, usageResp.Profiles, 2)
	require.NotEmpty(t, usageResp.Aggregates)

	// Check aggregate computation
	var geminiWeeklyAgg *AggregateBucket
	for _, agg := range usageResp.Aggregates {
		if agg.GroupName == "Gemini Models" && agg.Window == "weekly" {
			geminiWeeklyAgg = &agg
			break
		}
	}
	require.NotNil(t, geminiWeeklyAgg)
	require.Equal(t, 2, geminiWeeklyAgg.Instances)
	require.Equal(t, 85, geminiWeeklyAgg.AvgPercent)
}

func TestHandleAction_FilterInstance(t *testing.T) {
	agxDir := createMockAgxDir(t)
	p := newAntigravityUsagePlugin()
	host := &fakeHost{
		config: map[string]any{"agx_dir": agxDir},
	}
	p.SetHost(host)

	p.runner = func(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
		return []byte(sampleAgyJSON), nil
	}

	body, _ := json.Marshal(map[string]string{"instance": "kurtis"})
	resp, err := p.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: ActionProfilesUsage,
		Context:   pluginsdk.VerifiedActionContext{WorkspaceID: "ws-1"},
		Body:      body,
	})
	require.NoError(t, err)

	var usageResp UsageResponse
	require.NoError(t, json.Unmarshal(resp.Body, &usageResp))
	require.Len(t, usageResp.Profiles, 1)
	require.Equal(t, "kurtis", usageResp.Profiles[0].Profile.InstanceName)
}

func TestHandleAction_EnabledInstancesFilter(t *testing.T) {
	agxDir := createMockAgxDir(t)
	p := newAntigravityUsagePlugin()
	host := &fakeHost{
		config: map[string]any{"agx_dir": agxDir},
	}
	p.SetHost(host)

	queried := make(map[string]bool)
	p.runner = func(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
		for _, e := range env {
			if len(e) > 5 && e[:5] == "HOME=" {
				queried[filepath.Base(e[5:])] = true
			}
		}
		return []byte(sampleAgyJSON), nil
	}

	// Only enable "kurtis", leaving "jim" disabled
	body, _ := json.Marshal(map[string]any{"instances": []string{"kurtis"}})
	resp, err := p.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: ActionProfilesUsage,
		Context:   pluginsdk.VerifiedActionContext{WorkspaceID: "ws-1"},
		Body:      body,
	})
	require.NoError(t, err)

	var usageResp UsageResponse
	require.NoError(t, json.Unmarshal(resp.Body, &usageResp))
	require.Len(t, usageResp.Profiles, 2)

	// Verify only kurtis was queried with agy
	require.True(t, queried["kurtis"], "kurtis must be queried")
	require.False(t, queried["jim"], "jim must NOT be queried")

	// Verify jim profile returned as disabled
	for _, pu := range usageResp.Profiles {
		if pu.Profile.InstanceName == "jim" {
			require.Equal(t, "Disabled for Kandev", pu.Description)
			require.Empty(t, pu.Groups)
		} else if pu.Profile.InstanceName == "kurtis" {
			require.NotEmpty(t, pu.Groups)
		}
	}
}

func TestHandleWebhook_Usage(t *testing.T) {
	agxDir := createMockAgxDir(t)
	p := newAntigravityUsagePlugin()
	host := &fakeHost{
		config: map[string]any{"agx_dir": agxDir},
	}
	p.SetHost(host)

	p.runner = func(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
		return []byte(sampleAgyJSON), nil
	}

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: WebhookUsage,
		Method:     "POST",
	})
	require.NoError(t, err)
	require.Equal(t, int32(200), resp.Status)

	var usageResp UsageResponse
	require.NoError(t, json.Unmarshal(resp.Body, &usageResp))
	require.Len(t, usageResp.Profiles, 2)
}

func TestHandleAction_UnknownAction(t *testing.T) {
	p := newAntigravityUsagePlugin()
	_, err := p.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "unknown.action",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unknown action")
}
