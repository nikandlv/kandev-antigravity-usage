// kandev-antigravity-usage UI bundle — the frontend half of the plugin.
//
// Plain ES module executed inside the kandev SPA without an iframe.
// Uses host.React, host.jsx, and host.ui design system components.

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------
function icon(h, path, size, className) {
  return h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: size || 16,
      height: size || 16,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: className || "",
      "aria-hidden": "true",
    },
    h("path", { d: path }),
  );
}

const GAUGE_PATH = "M12 14l4-4m-9.172 6.172a8 8 0 1 1 11.314 0M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z";
const REFRESH_PATH = "M20 11a8.1 8.1 0 0 0-15.5-2m-.5-5v5h5M4 13a8.1 8.1 0 0 0 15.5 2m.5 5v-5h-5";
const SEARCH_PATH = "M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z";
const USER_PATH = "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8z";
const ALERT_PATH = "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01";
const CHECK_PATH = "M20 6L9 17l-5-5";
const INFO_PATH = "M12 16v-4M12 8h.01M12 21a9 9 0 100-18 9 9 0 000 18z";

// ---------------------------------------------------------------------------
// Helpers & Cache constants
// ---------------------------------------------------------------------------
const CACHE_KEY = "kandev_antigravity_usage_cache";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache
const PROFILE_STATUS_KEY = "kandev_antigravity_profile_status";

function formatResetTime(isoStr) {
  if (!isoStr) return "";
  const resetMs = new Date(isoStr).getTime();
  if (isNaN(resetMs)) return "";

  const diffMs = resetMs - Date.now();
  if (diffMs <= 0) return "resets soon";

  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    const remHours = diffHours % 24;
    return `in ${diffDays}d ${remHours}h`;
  }
  if (diffHours > 0) {
    const remMins = diffMins % 60;
    return `in ${diffHours}h ${remMins}m`;
  }
  return `in ${diffMins}m`;
}

function getQuotaStatus(percent, disabled) {
  if (disabled || percent <= 0) {
    return { label: "Depleted", color: "text-red-600 dark:text-red-400", badgeVariant: "destructive" };
  }
  if (percent < 25) {
    return { label: "Low", color: "text-amber-600 dark:text-amber-400", badgeVariant: "warning" };
  }
  if (percent < 60) {
    return { label: "Moderate", color: "text-blue-600 dark:text-blue-400", badgeVariant: "secondary" };
  }
  return { label: "Healthy", color: "text-emerald-600 dark:text-emerald-400", badgeVariant: "default" };
}

function getStoredProfileStatus() {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(PROFILE_STATUS_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Failed to read profile status from storage:", e);
  }
  return {};
}

function saveStoredProfileStatus(statusMap) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PROFILE_STATUS_KEY, JSON.stringify(statusMap));
    }
  } catch (e) {
    console.warn("Failed to save profile status to storage:", e);
  }
}

function getStoredCache() {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.cachedAt && parsed.data) {
        if (Date.now() - parsed.cachedAt < CACHE_TTL_MS) {
          return parsed;
        }
      }
    }
  } catch (e) {
    console.warn("Failed to read usage cache:", e);
  }
  return null;
}

function saveStoredCache(data) {
  try {
    if (typeof localStorage !== "undefined" && data) {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ data, cachedAt: Date.now() }),
      );
    }
  } catch (e) {
    console.warn("Failed to write usage cache:", e);
  }
}

function computeClientAggregates(profiles) {
  const stats = {};
  for (const pu of profiles || []) {
    if (pu.error || !pu.groups || pu.groups.length === 0) continue;
    for (const g of pu.groups) {
      for (const b of g.buckets || []) {
        const key = `${g.name}|${b.window}|${b.name}`;
        if (!stats[key]) {
          stats[key] = {
            group_name: g.name,
            window: b.window,
            bucket_name: b.name,
            sumFraction: 0,
            count: 0,
          };
        }
        stats[key].count += 1;
        stats[key].sumFraction += b.disabled ? 0 : (b.remaining_fraction || 0);
      }
    }
  }
  return Object.values(stats).map((s) => {
    const avg = s.count > 0 ? s.sumFraction / s.count : 0;
    return {
      group_name: s.group_name,
      window: s.window,
      bucket_name: s.bucket_name,
      instances: s.count,
      avg_remaining: avg,
      avg_percent: Math.round(avg * 100),
    };
  });
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------
function makeAntigravityUsagePage(host) {
  const { jsx: h, ui, toast, utils, api, context, store } = host;
  const {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Progress,
    Badge,
    Input,
    Spinner,
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Switch,
  } = ui;

  return function AntigravityUsagePage() {
    const React = host.React;

    // Load initial cache synchronously if valid (<10m old)
    const initialCache = React.useMemo(() => getStoredCache(), []);
    const [data, setData] = React.useState(() => initialCache?.data || null);
    const [cachedAt, setCachedAt] = React.useState(() => initialCache?.cachedAt || null);
    const [loading, setLoading] = React.useState(() => !initialCache);
    const [refreshing, setRefreshing] = React.useState(false);
    const [refreshingAgents, setRefreshingAgents] = React.useState({});
    const [profileStatus, setProfileStatus] = React.useState(() => getStoredProfileStatus());
    const [searchQuery, setSearchQuery] = React.useState("");
    const [viewMode, setViewMode] = React.useState("cards"); // 'cards' | 'table'
    const [error, setError] = React.useState(null);

    const dataRef = React.useMemo(() => ({ current: null }), []);
    dataRef.current = data;
    const hasFetchedOnMount = React.useMemo(() => ({ current: false }), []);

    // Read Kandev's agent-profile store to seed default enable/disable state
    const kandevAgentProfiles = React.useMemo(() => {
      try {
        const state = store && typeof store.getState === "function" ? store.getState() : null;
        return state?.agentProfiles?.items || [];
      } catch (_) {
        return [];
      }
    }, [store]);

    const isProfileEnabled = React.useCallback(
      (instanceName) => {
        if (!instanceName) return true;
        const key = instanceName.toLowerCase();
        if (typeof profileStatus[key] === "boolean") {
          return profileStatus[key];
        }
        const matched = kandevAgentProfiles.find(
          (ap) => (ap.name || "").toLowerCase() === key || (ap.agent_name || "").toLowerCase() === key,
        );
        if (matched && typeof matched.enabled === "boolean") {
          return matched.enabled;
        }
        return true;
      },
      [profileStatus, kandevAgentProfiles],
    );

    // Refresh a single agent profile
    const refreshSingleProfile = React.useCallback(
      async (instanceName) => {
        if (!instanceName) return;
        setRefreshingAgents((prev) => ({ ...prev, [instanceName]: true }));

        try {
          const workspaceId =
            (context && typeof context.getActiveWorkspaceId === "function" && context.getActiveWorkspaceId()) ||
            (context && typeof context.getWorkspaceIds === "function" && context.getWorkspaceIds()?.[0]) ||
            "";

          const payload = { instance: instanceName };
          let result = null;

          if (workspaceId && api && typeof api.invokeAction === "function") {
            try {
              result = await api.invokeAction("profiles.usage", {
                workspaceId,
                body: JSON.stringify(payload),
              });
            } catch (invokeErr) {
              console.warn("invokeAction single profile failed, falling back to webhook:", invokeErr);
            }
          }

          if (!result && api && typeof api.fetch === "function") {
            const res = await api.fetch("/webhooks/usage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (res.ok) {
              result = await res.json();
            }
          }

          if (result && !result.error && result.profiles && result.profiles.length > 0) {
            const updated = result.profiles[0];
            setData((prev) => {
              if (!prev) return prev;
              const existing = prev.profiles || [];
              let found = false;
              const nextProfiles = existing.map((p) => {
                if (p.profile?.instance_name?.toLowerCase() === instanceName.toLowerCase()) {
                  found = true;
                  return updated;
                }
                return p;
              });
              if (!found) nextProfiles.push(updated);

              const nextAggs = computeClientAggregates(nextProfiles);
              const nextData = {
                ...prev,
                profiles: nextProfiles,
                aggregates: nextAggs,
                fetched_at: new Date().toISOString(),
              };
              saveStoredCache(nextData);
              return nextData;
            });
            toast.success(`Refreshed ${instanceName} usage`);
          } else {
            const errMsg = result?.error || `Failed to refresh ${instanceName}`;
            toast.error(errMsg);
          }
        } catch (err) {
          toast.error(err.message || `Failed to refresh ${instanceName}`);
        } finally {
          setRefreshingAgents((prev) => ({ ...prev, [instanceName]: false }));
        }
      },
      [api, context, toast],
    );

    // Toggle profile enable/disable for Kandev
    const toggleProfile = React.useCallback(
      async (instanceName, nextEnabled) => {
        const key = instanceName.toLowerCase();
        const nextStatus = { ...profileStatus, [key]: nextEnabled };
        setProfileStatus(nextStatus);
        saveStoredProfileStatus(nextStatus);

        // Attempt to sync to Kandev's agent profile endpoint if available
        const matched = kandevAgentProfiles.find(
          (ap) => (ap.name || "").toLowerCase() === key || (ap.agent_name || "").toLowerCase() === key,
        );
        if (matched && matched.id && typeof window !== "undefined" && typeof window.fetch === "function") {
          try {
            await window.fetch(`/api/v1/agent-profiles/${matched.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: nextEnabled }),
            });
          } catch (err) {
            console.warn("Could not sync agent profile enabled state to Kandev API:", err);
          }
        }

        toast.success(
          `Profile "${instanceName}" ${nextEnabled ? "enabled" : "disabled"} for Kandev`,
        );

        if (nextEnabled) {
          refreshSingleProfile(instanceName);
        } else {
          setData((prev) => {
            if (!prev) return prev;
            const updatedProfiles = (prev.profiles || []).map((pu) => {
              if (pu.profile?.instance_name?.toLowerCase() === key) {
                return {
                  ...pu,
                  groups: [],
                  description: "Disabled for Kandev",
                };
              }
              return pu;
            });
            const updatedAggs = computeClientAggregates(updatedProfiles);
            const nextData = {
              ...prev,
              profiles: updatedProfiles,
              aggregates: updatedAggs,
            };
            saveStoredCache(nextData);
            return nextData;
          });
        }
      },
      [profileStatus, kandevAgentProfiles, refreshSingleProfile, toast],
    );

    // Full load / refresh: only fetches enabled profiles
    const loadUsage = React.useCallback(
      async (isManual = false) => {
        if (!isManual) {
          const cached = getStoredCache();
          if (cached && cached.data) {
            setData((prev) => prev || cached.data);
            setCachedAt((prev) => prev || cached.cachedAt);
            setLoading(false);
            return;
          }
        }

        if (isManual) setRefreshing(true);
        else setLoading(true);
        setError(null);

        try {
          const workspaceId =
            (context && typeof context.getActiveWorkspaceId === "function" && context.getActiveWorkspaceId()) ||
            (context && typeof context.getWorkspaceIds === "function" && context.getWorkspaceIds()?.[0]) ||
            "";

          // Discover profiles to know which ones are currently enabled
          let knownProfiles = (dataRef.current?.profiles || []).map((p) => p.profile?.instance_name).filter(Boolean);
          if (knownProfiles.length === 0 && workspaceId && api && typeof api.invokeAction === "function") {
            try {
              const listRes = await api.invokeAction("profiles.list", { workspaceId });
              if (listRes?.profiles) {
                knownProfiles = listRes.profiles.map((p) => p.instance_name);
              }
            } catch (_) {}
          }

          const currentStatus = getStoredProfileStatus();
          const enabledList = knownProfiles.filter((name) => {
            const key = name.toLowerCase();
            if (typeof currentStatus[key] === "boolean") return currentStatus[key];
            const matched = kandevAgentProfiles.find(
              (ap) => (ap.name || "").toLowerCase() === key || (ap.agent_name || "").toLowerCase() === key,
            );
            if (matched && typeof matched.enabled === "boolean") return matched.enabled;
            return true;
          });

          const filterBody = {
            instances: enabledList.length > 0 ? enabledList : undefined,
          };

          let result = null;
          if (workspaceId && api && typeof api.invokeAction === "function") {
            try {
              result = await api.invokeAction("profiles.usage", {
                workspaceId,
                body: JSON.stringify(filterBody),
              });
            } catch (invokeErr) {
              console.warn("invokeAction profiles.usage failed, falling back to webhook:", invokeErr);
            }
          }

          if (!result && api && typeof api.fetch === "function") {
            const res = await api.fetch("/webhooks/usage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(filterBody),
            });
            if (res.ok) {
              result = await res.json();
            }
          }

          if (result && !result.error) {
            setData(result);
            const now = Date.now();
            setCachedAt(now);
            saveStoredCache(result);
            if (isManual) {
              toast.success("Antigravity usage quotas refreshed");
            }
          } else {
            const errMsg = (result && result.error) || "Failed to load Antigravity usage";
            setError(errMsg);
            if (isManual) toast.error(errMsg);
          }
        } catch (err) {
          const msg = err.message || "Failed to communicate with usage service";
          setError(msg);
          if (isManual) toast.error(msg);
        } finally {
          setLoading(false);
          setRefreshing(false);
        }
      },
      [api, context, toast, kandevAgentProfiles],
    );

    React.useEffect(() => {
      // If we don't have fresh cached data, fetch on mount
      if (!initialCache && !hasFetchedOnMount.current) {
        hasFetchedOnMount.current = true;
        loadUsage(false);
      }
    }, []);

    const profiles = data?.profiles || [];
    const aggregates = data?.aggregates || [];

    const filteredProfiles = React.useMemo(() => {
      if (!searchQuery.trim()) return profiles;
      const q = searchQuery.toLowerCase();
      return profiles.filter(
        (p) =>
          p.profile?.instance_name?.toLowerCase().includes(q) ||
          p.profile?.role?.toLowerCase().includes(q),
      );
    }, [profiles, searchQuery]);

    // Aggregate summary cards
    const geminiWeeklyAgg = aggregates.find(
      (a) => a?.group_name?.includes("Gemini") && a?.window === "weekly",
    );
    const gemini5hAgg = aggregates.find(
      (a) => a?.group_name?.includes("Gemini") && a?.window === "5h",
    );
    const claudeWeeklyAgg = aggregates.find(
      (a) => a?.group_name?.includes("Claude") && a?.window === "weekly",
    );
    const claude5hAgg = aggregates.find(
      (a) => a?.group_name?.includes("Claude") && a?.window === "5h",
    );

    // Render switch helper (uses host.ui.Switch or fallback input)
    function renderProfileSwitch({ instanceName, isEnabled }) {
      if (Switch) {
        return h(Switch, {
          checked: isEnabled,
          onCheckedChange: (checked) => toggleProfile(instanceName, checked),
          "aria-label": `Enable ${instanceName} for Kandev`,
        });
      }
      return h("input", {
        type: "checkbox",
        checked: isEnabled,
        onChange: (e) => toggleProfile(instanceName, e.target.checked),
        "aria-label": `Enable ${instanceName} for Kandev`,
        className: "h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer",
      });
    }

    // Profile card renderer
    function renderProfileCard(pu) {
      const prof = pu.profile || {};
      const groups = pu.groups || [];
      const hasError = Boolean(pu.error);
      const isEnabled = isProfileEnabled(prof.instance_name);
      const isAgentRefreshing = Boolean(refreshingAgents[prof.instance_name]);

      return h(
        Card,
        {
          key: prof.instance_name,
          className: utils.cn(
            "flex flex-col border shadow-sm transition hover:shadow-md",
            !isEnabled && "opacity-80 bg-muted/10 border-dashed",
          ),
        },
        h(
          CardHeader,
          { className: "pb-3" },
          h(
            "div",
            { className: "flex items-start justify-between gap-3" },
            h(
              "div",
              { className: "flex items-center gap-3 min-w-0" },
              prof.avatar
                ? h("img", {
                    src: prof.avatar,
                    alt: prof.instance_name,
                    className: "h-9 w-9 rounded-full border bg-muted/30 p-0.5 object-cover shrink-0",
                    onError: (e) => {
                      e.target.style.display = "none";
                    },
                  })
                : h(
                    "div",
                    {
                      className:
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-sm",
                    },
                    (prof.instance_name || "A").substring(0, 2).toUpperCase(),
                  ),
              h(
                "div",
                { className: "min-w-0" },
                h(
                  "div",
                  { className: "flex items-center gap-2 flex-wrap" },
                  h(CardTitle, { className: "text-base font-semibold truncate" }, prof.instance_name),
                  hasError
                    ? h(Badge, { variant: "destructive", className: "text-xs" }, "Error")
                    : !isEnabled
                    ? h(Badge, { variant: "secondary", className: "text-xs font-normal" }, "Disabled in Kandev")
                    : h(
                        Badge,
                        { variant: "outline", className: "text-xs font-normal" },
                        prof.role || "Agent",
                      ),
                ),
                h(
                  CardDescription,
                  { className: "text-xs mt-0.5 text-muted-foreground truncate" },
                  prof.homeDir || `~/.agx/${prof.instance_name}`,
                ),
              ),
            ),
            h(
              "div",
              { className: "flex items-center gap-2 shrink-0" },
              // Single agent refresh button
              h(
                Tooltip,
                null,
                h(
                  TooltipTrigger,
                  { asChild: true },
                  h(
                    Button,
                    {
                      variant: "ghost",
                      size: "icon",
                      className: "h-8 w-8 cursor-pointer text-muted-foreground hover:text-foreground",
                      disabled: isAgentRefreshing || !isEnabled,
                      onClick: () => refreshSingleProfile(prof.instance_name),
                      "aria-label": `Refresh ${prof.instance_name} usage`,
                    },
                    isAgentRefreshing
                      ? h(Spinner, { className: "h-3.5 w-3.5" })
                      : icon(h, REFRESH_PATH, 14),
                  ),
                ),
                h(
                  TooltipContent,
                  null,
                  isEnabled ? `Refresh ${prof.instance_name} usage` : "Enable profile to refresh",
                ),
              ),
              // Kandev enable/disable toggle
              h(
                Tooltip,
                null,
                h(
                  TooltipTrigger,
                  { asChild: true },
                  h(
                    "div",
                    { className: "flex items-center" },
                    renderProfileSwitch({
                      instanceName: prof.instance_name,
                      isEnabled,
                    }),
                  ),
                ),
                h(
                  TooltipContent,
                  null,
                  isEnabled ? "Enabled for Kandev (click to disable)" : "Disabled for Kandev (click to enable)",
                ),
              ),
            ),
          ),
        ),
        h(
          CardContent,
          { className: "flex-1 space-y-4 pt-1" },
          hasError
            ? h(
                "div",
                {
                  className:
                    "rounded-md bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2",
                },
                icon(h, ALERT_PATH, 16, "shrink-0 mt-0.5"),
                h("span", null, pu.error),
              )
            : !isEnabled
            ? h(
                "div",
                { className: "rounded-lg border border-dashed bg-muted/10 p-5 text-center space-y-2" },
                h(
                  "p",
                  { className: "text-xs text-muted-foreground" },
                  "Profile disabled for Kandev. Live quotas are not fetched.",
                ),
                h(
                  Button,
                  {
                    size: "sm",
                    variant: "outline",
                    onClick: () => toggleProfile(prof.instance_name, true),
                    className: "text-xs cursor-pointer",
                  },
                  "Enable for Kandev",
                ),
              )
            : groups.length === 0
            ? h(
                "div",
                { className: "p-4 text-center text-xs text-muted-foreground" },
                "No quota groups returned.",
              )
            : groups.map((g) =>
                h(
                  "div",
                  { key: g.name, className: "space-y-2 rounded-lg border bg-muted/20 p-3" },
                  h(
                    "div",
                    { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground" },
                    g.name,
                  ),
                  h(
                    "div",
                    { className: "space-y-3" },
                    (g.buckets || []).map((b) => {
                      const status = getQuotaStatus(b.remaining_percent, b.disabled);
                      const resetDesc = formatResetTime(b.reset_time);
                      return h(
                        "div",
                        { key: b.id, className: "space-y-1" },
                        h(
                          "div",
                          { className: "flex items-center justify-between text-xs" },
                          h(
                            "span",
                            { className: "font-medium text-foreground flex items-center gap-1.5" },
                            b.name,
                            b.disabled
                              ? h(
                                  Badge,
                                  { variant: "destructive", className: "text-[10px] px-1 py-0" },
                                  "depleted",
                                )
                              : null,
                          ),
                          h(
                            "span",
                            { className: utils.cn("font-bold text-xs", status.color) },
                            b.disabled ? "0%" : `${b.remaining_percent}%`,
                          ),
                        ),
                        h(Progress, {
                          value: b.disabled ? 0 : b.remaining_percent,
                          className: "h-2",
                        }),
                        resetDesc
                          ? h(
                              "div",
                              { className: "flex items-center justify-between text-[11px] text-muted-foreground" },
                              h("span", null, "Full refresh"),
                              h("span", { className: "font-mono" }, resetDesc),
                            )
                          : null,
                      );
                    }),
                  ),
                ),
              ),
        ),
      );
    }

    // Detailed Table View
    function renderTableView() {
      return h(
        Card,
        { className: "border shadow-sm overflow-hidden" },
        h(
          Table,
          null,
          h(
            TableHeader,
            null,
            h(
              TableRow,
              null,
              h(TableHead, null, "Instance"),
              h(TableHead, null, "Role"),
              h(TableHead, null, "Kandev"),
              h(TableHead, null, "Gemini (Weekly)"),
              h(TableHead, null, "Gemini (5-Hour)"),
              h(TableHead, null, "Claude/GPT (Weekly)"),
              h(TableHead, null, "Claude/GPT (5-Hour)"),
              h(TableHead, null, "Status"),
              h(TableHead, { className: "text-right" }, "Actions"),
            ),
          ),
          h(
            TableBody,
            null,
            filteredProfiles.map((pu) => {
              const prof = pu.profile || {};
              const isEnabled = isProfileEnabled(prof.instance_name);
              const isAgentRefreshing = Boolean(refreshingAgents[prof.instance_name]);

              const geminiGroup = (pu.groups || []).find((g) => g?.name?.includes("Gemini"));
              const claudeGroup = (pu.groups || []).find((g) => g?.name?.includes("Claude"));

              const gWeekly = geminiGroup?.buckets?.find((b) => b.window === "weekly");
              const g5h = geminiGroup?.buckets?.find((b) => b.window === "5h");
              const cWeekly = claudeGroup?.buckets?.find((b) => b.window === "weekly");
              const c5h = claudeGroup?.buckets?.find((b) => b.window === "5h");

              return h(
                TableRow,
                { key: prof.instance_name, className: !isEnabled ? "opacity-75" : "" },
                h(
                  TableCell,
                  { className: "font-semibold text-sm flex items-center gap-2" },
                  prof.avatar
                    ? h("img", {
                        src: prof.avatar,
                        alt: prof.instance_name,
                        className: "h-6 w-6 rounded-full border bg-muted/20 object-cover",
                      })
                    : h(
                        "div",
                        {
                          className:
                            "flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-bold",
                        },
                        (prof.instance_name || "A").substring(0, 2).toUpperCase(),
                      ),
                  prof.instance_name,
                ),
                h(TableCell, { className: "text-muted-foreground text-xs" }, prof.role || "Agent"),
                h(
                  TableCell,
                  null,
                  renderProfileSwitch({
                    instanceName: prof.instance_name,
                    isEnabled,
                  }),
                ),
                h(
                  TableCell,
                  { className: "text-xs" },
                  !isEnabled
                    ? "—"
                    : gWeekly
                    ? h(
                        "span",
                        { className: getQuotaStatus(gWeekly.remaining_percent, gWeekly.disabled).color },
                        gWeekly.disabled ? "0% (Depleted)" : `${gWeekly.remaining_percent}%`,
                      )
                    : "—",
                ),
                h(
                  TableCell,
                  { className: "text-xs" },
                  !isEnabled
                    ? "—"
                    : g5h
                    ? h(
                        "span",
                        { className: getQuotaStatus(g5h.remaining_percent, g5h.disabled).color },
                        g5h.disabled ? "0% (Depleted)" : `${g5h.remaining_percent}%`,
                      )
                    : "—",
                ),
                h(
                  TableCell,
                  { className: "text-xs" },
                  !isEnabled
                    ? "—"
                    : cWeekly
                    ? h(
                        "span",
                        { className: getQuotaStatus(cWeekly.remaining_percent, cWeekly.disabled).color },
                        `${cWeekly.remaining_percent}%`,
                      )
                    : "—",
                ),
                h(
                  TableCell,
                  { className: "text-xs" },
                  !isEnabled
                    ? "—"
                    : c5h
                    ? h(
                        "span",
                        { className: getQuotaStatus(c5h.remaining_percent, c5h.disabled).color },
                        `${c5h.remaining_percent}%`,
                      )
                    : "—",
                ),
                h(
                  TableCell,
                  null,
                  pu.error
                    ? h(Badge, { variant: "destructive" }, "Error")
                    : !isEnabled
                    ? h(Badge, { variant: "secondary" }, "Disabled")
                    : gWeekly?.disabled || gWeekly?.remaining_percent === 0
                    ? h(Badge, { variant: "destructive" }, "Depleted")
                    : h(Badge, { variant: "default" }, "Active"),
                ),
                h(
                  TableCell,
                  { className: "text-right" },
                  h(
                    Tooltip,
                    null,
                    h(
                      TooltipTrigger,
                      { asChild: true },
                      h(
                        Button,
                        {
                          variant: "ghost",
                          size: "icon",
                          className: "h-7 w-7 cursor-pointer",
                          disabled: isAgentRefreshing || !isEnabled,
                          onClick: () => refreshSingleProfile(prof.instance_name),
                          "aria-label": `Refresh ${prof.instance_name}`,
                        },
                        isAgentRefreshing
                          ? h(Spinner, { className: "h-3.5 w-3.5" })
                          : icon(h, REFRESH_PATH, 13),
                      ),
                    ),
                    h(
                      TooltipContent,
                      null,
                      isEnabled ? `Refresh ${prof.instance_name}` : "Enable profile to refresh",
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      );
    }

    const enabledCount = profiles.filter((p) => isProfileEnabled(p.profile?.instance_name)).length;

    return h(
      "div",
      { className: "p-6 max-w-7xl mx-auto space-y-6" },

      // Header Toolbar
      h(
        "div",
        { className: "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4" },
        h(
          "div",
          null,
          h("h1", { className: "text-2xl font-bold tracking-tight text-foreground" }, "Antigravity Usage"),
          h(
            "p",
            { className: "text-sm text-muted-foreground mt-0.5" },
            "Monitor live usage quotas, 5-hour throttles, and weekly refresh limits across Antigravity agent profiles.",
          ),
        ),
        h(
          "div",
          { className: "flex items-center gap-2" },
          h(
            Button,
            {
              variant: viewMode === "cards" ? "secondary" : "ghost",
              size: "sm",
              onClick: () => setViewMode("cards"),
            },
            "Cards",
          ),
          h(
            Button,
            {
              variant: viewMode === "table" ? "secondary" : "ghost",
              size: "sm",
              onClick: () => setViewMode("table"),
            },
            "Table",
          ),
          h(
            Button,
            {
              variant: "outline",
              size: "sm",
              disabled: loading || refreshing,
              onClick: () => loadUsage(true),
              className: "flex items-center gap-1.5 cursor-pointer",
            },
            refreshing
              ? h(Spinner, { className: "h-3.5 w-3.5" })
              : icon(h, REFRESH_PATH, 14),
            "Refresh",
          ),
        ),
      ),

      // Aggregate KPI Cards
      h(
        "div",
        { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" },
        h(
          Card,
          { className: "p-4 border shadow-sm" },
          h("div", { className: "text-xs font-medium text-muted-foreground" }, "Configured Profiles"),
          h("div", { className: "text-2xl font-bold mt-1" }, profiles.length),
          h(
            "p",
            { className: "text-xs text-muted-foreground mt-1" },
            `${enabledCount} enabled for Kandev, ${profiles.length - enabledCount} disabled`,
          ),
        ),
        h(
          Card,
          { className: "p-4 border shadow-sm" },
          h("div", { className: "text-xs font-medium text-muted-foreground" }, "Gemini Weekly (Avg)"),
          h(
            "div",
            { className: utils.cn("text-2xl font-bold mt-1", getQuotaStatus(geminiWeeklyAgg?.avg_percent ?? 0).color) },
            geminiWeeklyAgg ? `${geminiWeeklyAgg.avg_percent}%` : "—",
          ),
          h(Progress, { value: geminiWeeklyAgg?.avg_percent || 0, className: "h-1.5 mt-2" }),
        ),
        h(
          Card,
          { className: "p-4 border shadow-sm" },
          h("div", { className: "text-xs font-medium text-muted-foreground" }, "Gemini 5-Hour (Avg)"),
          h(
            "div",
            { className: utils.cn("text-2xl font-bold mt-1", getQuotaStatus(gemini5hAgg?.avg_percent ?? 0).color) },
            gemini5hAgg ? `${gemini5hAgg.avg_percent}%` : "—",
          ),
          h(Progress, { value: gemini5hAgg?.avg_percent || 0, className: "h-1.5 mt-2" }),
        ),
        h(
          Card,
          { className: "p-4 border shadow-sm" },
          h("div", { className: "text-xs font-medium text-muted-foreground" }, "Claude & GPT Weekly (Avg)"),
          h(
            "div",
            { className: utils.cn("text-2xl font-bold mt-1", getQuotaStatus(claudeWeeklyAgg?.avg_percent ?? 0).color) },
            claudeWeeklyAgg ? `${claudeWeeklyAgg.avg_percent}%` : "—",
          ),
          h(Progress, { value: claudeWeeklyAgg?.avg_percent || 0, className: "h-1.5 mt-2" }),
        ),
      ),

      // Search & Filter Bar
      h(
        "div",
        { className: "flex items-center gap-3 flex-wrap justify-between" },
        h(
          "div",
          { className: "relative flex-1 max-w-sm" },
          h(
            "div",
            { className: "absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground" },
            icon(h, SEARCH_PATH, 14),
          ),
          h(Input, {
            type: "text",
            placeholder: "Search profile by name or role...",
            value: searchQuery,
            onChange: (e) => setSearchQuery(e.target.value),
            className: "pl-9 text-sm",
          }),
        ),
        h(
          "div",
          { className: "flex items-center gap-2 text-xs text-muted-foreground" },
          cachedAt
            ? h(
                Badge,
                { variant: "secondary", className: "text-[11px] font-normal" },
                `Cached (10m TTL) • ${
                  utils?.formatRelativeTime
                    ? utils.formatRelativeTime(new Date(cachedAt).toISOString())
                    : new Date(cachedAt).toLocaleTimeString()
                }`,
              )
            : data?.fetched_at
            ? h(
                "span",
                null,
                `Updated: ${
                  utils?.formatRelativeTime
                    ? utils.formatRelativeTime(data.fetched_at)
                    : new Date(data.fetched_at).toLocaleTimeString()
                }`,
              )
            : null,
        ),
      ),

      // Error Banner
      error
        ? h(
            "div",
            { className: "rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive flex items-center justify-between" },
            h("div", { className: "flex items-center gap-2" }, icon(h, ALERT_PATH, 16), h("span", null, error)),
            h(Button, { size: "sm", variant: "outline", onClick: () => loadUsage(true) }, "Retry"),
          )
        : null,

      // Main Content Area
      loading
        ? h(
            "div",
            { className: "flex flex-col items-center justify-center py-16 space-y-3" },
            h(Spinner, { className: "h-8 w-8 text-primary" }),
            h("p", { className: "text-sm text-muted-foreground" }, "Fetching Antigravity quotas..."),
          )
        : filteredProfiles.length === 0
        ? h(
            Empty,
            null,
            h(
              EmptyHeader,
              null,
              h(EmptyMedia, { variant: "icon" }, icon(h, USER_PATH, 24)),
              h(EmptyTitle, null, "No Antigravity profiles found"),
              h(
                EmptyDescription,
                null,
                searchQuery
                  ? `No profiles matching "${searchQuery}".`
                  : "No profiles found under ~/.agx. Check plugin configuration in Settings > Plugins.",
              ),
            ),
          )
        : viewMode === "cards"
        ? h(
            "div",
            { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5" },
            filteredProfiles.map(renderProfileCard),
          )
        : renderTableView(),
    );
  };
}

// ---------------------------------------------------------------------------
// Chat Composer Toolbar Action
// ---------------------------------------------------------------------------
function makeChatToolbarAction(host) {
  const { jsx: h, ui } = host;
  const { Button, Tooltip, TooltipTrigger, TooltipContent } = ui;

  return function ChatToolbarAction({ slotProps }) {
    const translate =
      host.i18n && host.i18n.useTranslation ? host.i18n.useTranslation().t : null;
    const actionLabel = translate
      ? translate("openAntigravityUsage", { defaultValue: "Antigravity Usage — View agent quotas" })
      : "Antigravity Usage — View agent quotas";

    const tooltip = actionLabel;

    if (typeof ui.Action === "function") {
      return h(ui.Action, {
        id: "antigravity-usage-chat-action",
        label: actionLabel,
        icon: icon(h, GAUGE_PATH),
        tooltip,
        onClick: () => host.navigate("/antigravity-usage"),
      });
    }

    return h(
      Tooltip,
      null,
      h(
        TooltipTrigger,
        { asChild: true },
        h(
          Button,
          {
            id: "antigravity-usage-chat-action",
            type: "button",
            variant: "ghost",
            size: "icon",
            className: "h-7 w-7 cursor-pointer hover:bg-muted/40",
            "aria-label": tooltip,
            onClick: () => host.navigate("/antigravity-usage"),
          },
          icon(h, GAUGE_PATH),
        ),
      ),
      h(TooltipContent, null, tooltip),
    );
  };
}

// ---------------------------------------------------------------------------
// Plugin Registration
// ---------------------------------------------------------------------------
window.registerKandevPlugin("kandev-antigravity-usage", {
  initialize(registry, host) {
    registry.registerNavItem({
      id: "antigravity-usage",
      label: "Antigravity Usage",
      path: "/antigravity-usage",
      icon: "gauge",
      section: "main",
    });

    registry.registerRoute("/antigravity-usage", makeAntigravityUsagePage(host), {
      topbar: { subtitle: "Antigravity Agent Quotas & Limits" },
    });

    registry.registerComponent("chat-input-actions", makeChatToolbarAction(host));
  },

  destroy() {
    // Teardown logic if needed
  },
});
