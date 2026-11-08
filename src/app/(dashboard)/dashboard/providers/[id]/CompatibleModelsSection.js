"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
function CompatibleModelRow({ modelId, fullModel, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting }) {
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <span
        className="material-symbols-outlined text-base text-text-muted"
        style={iconColor ? { color: iconColor } : undefined}
      >
        {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{modelId}</p>
        <div className="flex items-center gap-1 mt-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          <div className="relative group/btn">
            <button
              onClick={() => onCopy(fullModel, `model-${modelId}`)}
              className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${modelId}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${modelId}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {onTest && (
            <div className="relative group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
        </div>
      </div>
      <button
        onClick={onDeleteAlias}
        className="p-1 hover:bg-red-50 rounded text-red-500"
        title="Remove model"
      >
        <span className="material-symbols-outlined text-sm">delete</span>
      </button>
    </div>
  );
}

// A failure caused by a timeout / transient upstream problem says nothing about
// access, so those models are kept. Anything else (401/403/404/400, plan or
// "model not found" errors, ...) means the account cannot use the model.
function isTransientFailure(r) {
  if (!r || r.ok) return false;
  if ([408, 425, 429, 500, 502, 503, 504].includes(r.status)) return true;
  return /timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network error|fetch failed|rate limit/i.test(r.error || "");
}

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, connections, isAnthropic }) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testingModelIds, setTestingModelIds] = useState(() => new Set());
  const [modelTestResults, setModelTestResults] = useState({});
  const [modelTestErrors, setModelTestErrors] = useState({});
  const [testingAllModels, setTestingAllModels] = useState(false);
  const [testAllProgress, setTestAllProgress] = useState(null);
  const [testAllNote, setTestAllNote] = useState("");

  const handleTestModel = async (modelId) => {
    // A Set (not a single id) so the 4-way test-all pool can run different
    // models concurrently without clobbering each other's in-flight marker.
    if (testingModelIds.has(modelId)) return null;
    setTestingModelIds((prev) => new Set(prev).add(modelId));
    let result;
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      result = { ok: !!data.ok, error: data.ok ? "" : (data.error || "Model not reachable"), status: data.status };
    } catch {
      result = { ok: false, error: "Network error" };
    } finally {
      setTestingModelIds((prev) => { const n = new Set(prev); n.delete(modelId); return n; });
    }
    setModelTestResults((prev) => ({ ...prev, [modelId]: result.ok ? "ok" : "error" }));
    // Failures always land in modelTestErrors — single-test clicks show them in
    // the row status, and the test-all flow renders the aggregate panel above.
    setModelTestErrors((prev) => ({ ...prev, [modelId]: result.ok ? null : { error: result.error, status: result.status } }));
    return result;
  };

  // Test every model of this provider with a small worker pool, then drop the
  // ones the account has no access to: custom models are deleted, legacy model
  // aliases are removed. Timeouts and transient upstream errors are kept.
  const handleTestAllModels = async (rows) => {
    if (testingAllModels || rows.length === 0) return;
    setTestingAllModels(true);
    setModelTestErrors({});
    setTestAllNote("");
    setTestAllProgress({ done: 0, total: rows.length });
    const results = new Map();
    const queue = [...rows];
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        // null = already in flight elsewhere (single-test racing this run).
        // Skip it — don't store a fake success or touch its row status.
        const res = await handleTestModel(row.id);
        if (res) results.set(row.id, res);
        setTestAllProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));

      const failedRows = rows.filter((r) => results.get(r.id) && !results.get(r.id).ok);
      const removable = failedRows.filter((r) => !isTransientFailure(results.get(r.id)));
      const kept = failedRows.length - removable.length;
      if (removable.length === 0) {
        setTestAllNote(failedRows.length ? `${failedRows.length} failed (timeout/transient), nothing removed.` : "All models OK.");
      } else if (removable.length === rows.length) {
        // Every model failing the same way points at the connection/key, not per-model access.
        setTestAllNote("All models failed — likely a connection/API key problem, nothing removed.");
      } else {
        for (const r of removable) {
          try {
            if (r.source === "custom") await onDeleteCustomModel(r.id);
            else if (r.source === "legacyAlias" && r.alias) await onDeleteAlias(r.alias);
          } catch (error) {
            console.log("Error removing model:", error);
          }
        }
        setTestAllNote(`${removable.length} model(s) removed for no access${kept ? `, ${kept} transient failure(s) kept` : ""}.`);
      }
    } finally {
      setTestingAllModels(false);
    }
  };

  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to import models");
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert("No models returned from /models.");
        return;
      }
      let importedCount = 0;
      for (const model of models) {
        const modelId = model.id || model.name || model.model;
        if (!modelId) continue;
        if (allModels.some((entry) => entry.id === modelId)) continue;
        await onAddCustomModel(modelId);
        importedCount += 1;
      }
      if (importedCount === 0) {
        alert("All models already exist, no new models added");
      } else {
        alert(`Successfully added ${importedCount} models`);
      }
    } catch (error) {
      console.log("Error importing models:", error);
    } finally {
      setImporting(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* Copy every model id (one per line) — pastes straight into the combo's Bulk add by ID */}
        {allModels.length > 0 && (
          <button
            onClick={() => onCopy(
              allModels.map((m) => `${providerDisplayAlias}/${m.id}`).join("\n"),
              "all-model-ids"
            )}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-text-muted transition-colors hover:border-primary/50 hover:text-primary"
          >
            <span className="material-symbols-outlined text-sm">{copied === "all-model-ids" ? "check" : "content_copy"}</span>
            {copied === "all-model-ids" ? "Copied!" : `Copy all IDs (${allModels.length})`}
          </button>
        )}

        {/* Test every model at once and prune the ones with no access */}
        {allModels.length > 0 && (
          <button
            onClick={() => handleTestAllModels(allModels.map((m) => ({ id: m.id, source: m.source, alias: m.alias })))}
            disabled={testingAllModels}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-amber-500/40 px-3 py-2 text-xs text-amber-600 dark:text-amber-400 transition-colors hover:border-amber-500 hover:bg-amber-500/5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-sm" style={testingAllModels ? { animation: "spin 1s linear infinite" } : undefined}>
              {testingAllModels ? "progress_activity" : "fact_check"}
            </span>
            {testingAllModels && testAllProgress ? `Testing ${testAllProgress.done}/${testAllProgress.total}...` : "Test All Models"}
          </button>
        )}
      </div>

      {(() => {
        const failed = Object.entries(modelTestErrors).filter(([, v]) => v);
        if (failed.length === 0) return testAllNote ? <p className="text-xs text-text-muted">{testAllNote}</p> : null;
        const noAccess = (v) => v.status === 401 || v.status === 403 || /HTTP (401|403)|plan|subscription|upgrade|not (have )?access|forbidden|not allowed|permission/i.test(v.error || "");
        const denied = failed.filter(([, v]) => noAccess(v));
        const other = failed.filter(([, v]) => !noAccess(v));
        return (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs">
            <p className="mb-2 font-medium text-red-600 dark:text-red-400">
              {failed.length} model(s) failed — {denied.length} no access, {other.length} other errors
            </p>
            {testAllNote && <p className="mb-2 text-text-main">{testAllNote}</p>}
            {[["No access", denied], ["Other errors", other]].map(([label, rows]) => rows.length > 0 && (
              <div key={label} className="mb-2">
                <p className="mb-1 text-text-muted">{label}</p>
                <ul className="space-y-0.5">
                  {rows.map(([id, v]) => (
                    <li key={id} className="break-words"><code>{id}</code> <span className="text-text-muted">— {String(v.error).slice(0, 160)}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );
      })()}

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {allModels.length > 0 && (
        <div className="flex flex-col gap-3">
          {allModels.map(({ id, alias, source }) => (
            <CompatibleModelRow
              key={`${source}-${providerStorageAlias}/${id}`}
              modelId={id}
              fullModel={`${providerDisplayAlias}/${id}`}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id) : onDeleteAlias(alias)}
              onTest={connections.length > 0 ? () => handleTestModel(id) : undefined}
              testStatus={modelTestResults[id]}
              isTesting={testingModelIds.has(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
};
