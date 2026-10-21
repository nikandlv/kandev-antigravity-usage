import assert from "node:assert/strict";
import test from "node:test";

let importCount = 0;

function element(type, props, ...children) {
  return { type, props: props || {}, children };
}

// Simple React mock for component testing
function mockReact() {
  const stateValues = [];
  let stateIndex = 0;

  return {
    useState(initial) {
      const idx = stateIndex++;
      if (stateValues[idx] === undefined) {
        stateValues[idx] = typeof initial === "function" ? initial() : initial;
      }
      const setState = (val) => {
        stateValues[idx] = typeof val === "function" ? val(stateValues[idx]) : val;
      };
      return [stateValues[idx], setState];
    },
    useEffect(fn) {
      // no-op in simple mock
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
    _reset() {
      stateIndex = 0;
    },
  };
}

async function loadPlugin({ action, i18n = true, React = mockReact(), localStorageMock = null } = {}) {
  let pluginId;
  let definition;
  const storeState = {
    agentProfiles: {
      items: [
        { id: "p1", name: "Kurtis", enabled: true },
        { id: "p2", name: "Jim", enabled: false },
      ],
    },
  };

  const ls = localStorageMock || {
    _data: {},
    getItem(k) {
      return this._data[k] || null;
    },
    setItem(k, v) {
      this._data[k] = String(v);
    },
    removeItem(k) {
      delete this._data[k];
    },
    clear() {
      this._data = {};
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      registerKandevPlugin(id, pluginDefinition) {
        pluginId = id;
        definition = pluginDefinition;
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Linux" },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: ls,
  });

  await import(new URL(`../ui/bundle.js?action-test=${importCount++}`, import.meta.url));

  const components = [];
  const navigations = [];
  const navItems = [];
  const routes = [];

  const ui = {
    Button: "Button",
    Tooltip: "Tooltip",
    TooltipTrigger: "TooltipTrigger",
    TooltipContent: "TooltipContent",
    Card: "Card",
    CardContent: "CardContent",
    CardDescription: "CardDescription",
    CardHeader: "CardHeader",
    CardTitle: "CardTitle",
    Progress: "Progress",
    Badge: "Badge",
    Input: "Input",
    Spinner: "Spinner",
    Empty: "Empty",
    EmptyDescription: "EmptyDescription",
    EmptyHeader: "EmptyHeader",
    EmptyMedia: "EmptyMedia",
    EmptyTitle: "EmptyTitle",
    Table: "Table",
    TableBody: "TableBody",
    TableCell: "TableCell",
    TableHead: "TableHead",
    TableHeader: "TableHeader",
    TableRow: "TableRow",
    Switch: "Switch",
  };
  if (action) ui.Action = action;

  const invokedActions = [];
  const host = {
    React,
    jsx: element,
    ui,
    toast: {
      success() {},
      error() {},
    },
    utils: {
      cn(...classes) {
        return classes.filter(Boolean).join(" ");
      },
      formatRelativeTime(iso) {
        return "recently";
      },
    },
    api: {
      invokeAction: async (key, payload) => {
        invokedActions.push({ key, payload });
        return { profiles: [], aggregates: [] };
      },
      fetch: async (path, opts) => {
        return {
          ok: true,
          json: async () => ({ profiles: [], aggregates: [] }),
        };
      },
    },
    context: {
      getActiveWorkspaceId: () => "ws-test",
    },
    store: {
      getState: () => storeState,
    },
    navigate(path) {
      navigations.push(path);
    },
  };

  if (i18n) {
    host.i18n = {
      useTranslation() {
        return {
          t(key, options) {
            return `localized:${key}:${options?.defaultValue || ""}`;
          },
        };
      },
    };
  }

  const registry = {
    registerNavItem(item) {
      navItems.push(item);
    },
    registerRoute(path, component, opts) {
      routes.push({ path, component, opts });
    },
    registerWsHandler() {},
    registerComponent(slot, component) {
      components.push({ slot, component });
    },
  };
  definition.initialize(registry, host);
  return { pluginId, components, host, navigations, navItems, routes, invokedActions, localStorage: ls };
}

function findNodes(node, type) {
  if (!node) return [];
  if (Array.isArray(node)) {
    return node.flatMap((child) => findNodes(child, type));
  }
  if (typeof node !== "object") return [];
  const current = node.type === type ? [node] : [];
  return current.concat((node.children || []).flatMap((child) => findNodes(child, type)));
}

function composerComponent(components) {
  const registrations = components.filter((entry) => entry.slot === "chat-input-actions");
  assert.equal(registrations.length, 1, "the composer slot keeps one registration");
  return registrations[0].component;
}

test("uses Action once when the host exports it", async () => {
  function Action() {}
  const loaded = await loadPlugin({ action: Action });
  const control = composerComponent(loaded.components)({ slotProps: { taskTitle: "Example task" } });

  assert.equal(loaded.pluginId, "kandev-antigravity-usage");
  assert.equal(control.type, Action);
  assert.equal(control.props.id, "antigravity-usage-chat-action");
  assert.equal(control.props.label, "localized:openAntigravityUsage:Antigravity Usage — View agent quotas");
  assert.match(control.props.tooltip, /Antigravity Usage/);
  assert.equal(findNodes(control, "Button").length, 0);
  control.props.onClick();
  assert.deepEqual(loaded.navigations, ["/antigravity-usage"]);
});

test("keeps one legacy Button path on a host without Action or i18n", async () => {
  const loaded = await loadPlugin({ action: null, i18n: false });
  const control = composerComponent(loaded.components)({ slotProps: { taskId: "task-123" } });
  const buttons = findNodes(control, "Button");

  assert.equal(loaded.pluginId, "kandev-antigravity-usage");
  assert.equal(control.type, "Tooltip");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.id, "antigravity-usage-chat-action");
  assert.match(buttons[0].props["aria-label"], /Antigravity Usage/);
  assert.equal(findNodes(control, "Action").length, 0);
  buttons[0].props.onClick();
  assert.deepEqual(loaded.navigations, ["/antigravity-usage"]);
});

test("registers Antigravity Usage navigation item with exact label", async () => {
  const loaded = await loadPlugin({});
  assert.equal(loaded.navItems.length, 1);
  assert.equal(loaded.navItems[0].id, "antigravity-usage");
  assert.equal(loaded.navItems[0].label, "Antigravity Usage", "Name must be Antigravity Usage instead of Agent Usage");
  assert.equal(loaded.navItems[0].path, "/antigravity-usage");

  assert.equal(loaded.routes.length, 1);
  assert.equal(loaded.routes[0].path, "/antigravity-usage");
  assert.equal(typeof loaded.routes[0].component, "function");
});

test("renders page with Antigravity Usage title and cached data without refetching", async () => {
  const ls = {
    _data: {},
    getItem(k) {
      return this._data[k] || null;
    },
    setItem(k, v) {
      this._data[k] = String(v);
    },
  };

  // Seed cache 2 minutes ago (well within 10 minute TTL)
  const cachedPayload = {
    cachedAt: Date.now() - 2 * 60 * 1000,
    data: {
      fetched_at: new Date().toISOString(),
      profiles: [
        {
          profile: { instance_name: "Kurtis", role: "Autonomous Planner" },
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "g1", name: "Weekly Limit", remaining_percent: 85, disabled: false, window: "weekly" },
              ],
            },
          ],
        },
      ],
      aggregates: [
        { group_name: "Gemini Models", window: "weekly", bucket_name: "Weekly Limit", avg_percent: 85 },
      ],
    },
  };
  ls.setItem("kandev_antigravity_usage_cache", JSON.stringify(cachedPayload));

  const loaded = await loadPlugin({ localStorageMock: ls });
  const Page = loaded.routes[0].component;
  const rendered = Page();

  // Verify h1 title is "Antigravity Usage"
  const h1Nodes = findNodes(rendered, "h1");
  assert.equal(h1Nodes.length, 1);
  assert.equal(h1Nodes[0].children[0], "Antigravity Usage", "Page heading must be Antigravity Usage");

  // Verify no action was invoked on initial load because cache was valid (<10m)
  assert.equal(loaded.invokedActions.length, 0, "Must not refetch when cache is within 10 minutes");

  // Verify Card contains single agent refresh button and Switch
  const buttons = findNodes(rendered, "Button");
  const refreshAgentButton = buttons.find((b) => b.props["aria-label"] === "Refresh Kurtis usage");
  assert.ok(refreshAgentButton, "Card must include single agent refresh button");

  const switches = findNodes(rendered, "Switch");
  assert.ok(switches.length >= 1, "Card must include Switch to enable/disable for Kandev");
});

test("refetches when cache is older than 10 minutes", async () => {
  const ls = {
    _data: {},
    getItem(k) {
      return this._data[k] || null;
    },
    setItem(k, v) {
      this._data[k] = String(v);
    },
  };

  // Expired cache (15 minutes old)
  ls.setItem(
    "kandev_antigravity_usage_cache",
    JSON.stringify({
      cachedAt: Date.now() - 15 * 60 * 1000,
      data: { profiles: [] },
    }),
  );

  const loaded = await loadPlugin({ localStorageMock: ls });
  const Page = loaded.routes[0].component;
  const rendered = Page();

  // Loading indicator rendered because cache expired
  const spinners = findNodes(rendered, "Spinner");
  assert.ok(spinners.length > 0, "Should show loading spinner when cache is expired (>10 minutes)");
});
