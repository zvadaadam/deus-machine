import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { WorkspaceDetail } from "./WorkspaceDetail";
import { TerminalPanel } from "./TerminalPanel";
import { API_CONFIG } from "./config/api.config";
import { formatTokenCount } from "./utils";
import {
  NewWorkspaceModal,
  DiffModal,
  SystemPromptModal,
  RepoGroup as RepoGroupComponent,
} from "./features/dashboard/components";
import type {
  Workspace,
  RepoGroup,
  DiffStats,
  FileChange,
  Stats,
  Repo,
  PRStatus,
  DevServer,
} from "./types";

/**
 * OpenDevs Dashboard - Main application interface
 * Manages workspaces, file changes, and git diff visualization
 */

const API_BASE = API_CONFIG.BASE_URL;
const POLL_INTERVAL = API_CONFIG.POLL_INTERVAL;

export function Dashboard() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>("Connecting...");
  const [repoGroups, setRepoGroups] = useState<RepoGroup[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [diffStats, setDiffStats] = useState<Record<string, DiffStats>>({});
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const fileChangesCache = useRef<Record<string, FileChange[]>>({});
  const [showNewWorkspaceModal, setShowNewWorkspaceModal] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [compactHandler, setCompactHandler] = useState<(() => void) | null>(null);
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);
  const [stopHandler, setStopHandler] = useState<(() => void) | null>(null);

  // System Prompt Editor
  const [showSystemPromptModal, setShowSystemPromptModal] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [loadingSystemPrompt, setLoadingSystemPrompt] = useState(false);
  const [savingSystemPrompt, setSavingSystemPrompt] = useState(false);

  // PR Status
  const [prStatus, setPrStatus] = useState<PRStatus | null>(null);

  // Dev Servers
  const [devServers, setDevServers] = useState<DevServer[]>([]);

  /**
   * Load workspaces and stats only (no diff stats)
   * Called by polling to update workspace list
   */
  const loadWorkspaces = useCallback(async () => {
    try {
      // Load grouped workspaces (ready only)
      const groupedRes = await fetch(`${API_BASE}/workspaces/by-repo?state=ready`);
      const groupedData = await groupedRes.json();
      setRepoGroups(groupedData);

      // Load stats
      const statsRes = await fetch(`${API_BASE}/stats`);
      const statsData = await statsRes.json();
      setStats(statsData);

      setStatus("Connected");
      return groupedData;
    } catch (error) {
      console.error("Failed to load workspaces:", error);
      setStatus(`Error: ${error}`);
      return [];
    }
  }, []);

  /**
   * Refresh diff stats for all current workspaces
   * Called by polling - updates all at once without staggering
   */
  const refreshDiffStats = useCallback(async (workspaces: Workspace[]) => {
    if (!workspaces || workspaces.length === 0) return;

    // Load all diff stats in parallel (fast update for polling)
    const allWorkspaces = workspaces;

    const diffPromises = allWorkspaces.map(async (workspace) => {
      try {
        const diffRes = await fetch(`${API_BASE}/workspaces/${workspace.id}/diff-stats`);
        const diffData = await diffRes.json();
        return { id: workspace.id, data: diffData };
      } catch (error) {
        console.error(`Failed to refresh diff stats for ${workspace.id}:`, error);
        return null;
      }
    });

    const results = await Promise.all(diffPromises);

    // Batch update all diff stats at once to avoid multiple re-renders
    const newDiffStats: Record<string, DiffStats> = {};
    results.forEach(result => {
      if (result) {
        newDiffStats[result.id] = result.data;
      }
    });

    setDiffStats(prev => ({ ...prev, ...newDiffStats }));
  }, []);

  /**
   * Initial load with progressive diff stats loading
   * Only called once on mount
   */
  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Load workspaces first
      const groupedData = await loadWorkspaces();

      // Progressive diff stats loading:
      // Load first 5 immediately, then gradually load the rest in background
      const allWorkspaces = groupedData.flatMap((g: RepoGroup) => g.workspaces);

      if (allWorkspaces.length > 0) {
        // Load first 5 immediately for quick visual feedback
        const first5 = allWorkspaces.slice(0, 5);
        first5.forEach(async (workspace: Workspace) => {
          try {
            const diffRes = await fetch(`${API_BASE}/workspaces/${workspace.id}/diff-stats`);
            const diffData = await diffRes.json();
            setDiffStats(prev => ({ ...prev, [workspace.id]: diffData }));
          } catch (error) {
            console.error(`Failed to load diff stats for ${workspace.id}:`, error);
          }
        });

        // Load remaining workspaces gradually in background (if any)
        if (allWorkspaces.length > 5) {
          setTimeout(() => {
            const remaining = allWorkspaces.slice(5);
            remaining.forEach(async (workspace: Workspace, index: number) => {
              // Stagger requests by 200ms each to avoid overwhelming
              setTimeout(async () => {
                try {
                  const diffRes = await fetch(`${API_BASE}/workspaces/${workspace.id}/diff-stats`);
                  const diffData = await diffRes.json();
                  setDiffStats(prev => ({ ...prev, [workspace.id]: diffData }));
                } catch (error) {
                  console.error(`Failed to load diff stats for ${workspace.id}:`, error);
                }
              }, index * 200);
            });
          }, 500);
        }
      }

      setLoading(false);
    } catch (error) {
      console.error("Failed to load data:", error);
      setStatus(`Error: ${error}`);
      setLoading(false);
    }
  }, [loadWorkspaces]);

  // Load file changes AND diff stats when a workspace is selected (with caching)
  useEffect(() => {
    if (selectedWorkspace) {
      const workspaceId = selectedWorkspace.id;

      // Load diff stats for this workspace if not already loaded
      if (!diffStats[workspaceId]) {
        fetch(`${API_BASE}/workspaces/${workspaceId}/diff-stats`)
          .then(res => res.json())
          .then(data => {
            setDiffStats(prev => ({ ...prev, [workspaceId]: data }));
          })
          .catch(err => {
            console.error('Failed to load diff stats:', err);
          });
      }

      // Load PR status
      fetch(`${API_BASE}/workspaces/${workspaceId}/pr-status`)
        .then(res => res.json())
        .then(data => {
          setPrStatus(data);
        })
        .catch(err => {
          console.error('Failed to load PR status:', err);
          setPrStatus(null);
        });

      // Load dev servers
      fetch(`${API_BASE}/workspaces/${workspaceId}/dev-servers`)
        .then(res => res.json())
        .then(data => {
          setDevServers(data.servers || []);
        })
        .catch(err => {
          console.error('Failed to load dev servers:', err);
          setDevServers([]);
        });

      // Check cache first for file changes
      if (fileChangesCache.current[workspaceId]) {
        console.log('✅ Using cached file changes for workspace:', workspaceId);
        setFileChanges(fileChangesCache.current[workspaceId]);
        return;
      }

      // Load from API if not in cache
      console.log('🔄 Loading file changes for workspace:', workspaceId);
      fetch(`${API_BASE}/workspaces/${workspaceId}/diff-files`)
        .then(res => res.json())
        .then(data => {
          const files = data.files || [];
          console.log('✅ File changes loaded:', files.length, 'files');
          setFileChanges(files);
          // Cache the result
          fileChangesCache.current[workspaceId] = files;
        })
        .catch(err => {
          console.error('❌ Failed to load file changes:', err);
          setFileChanges([]);
        });
    } else {
      setFileChanges([]);
      setPrStatus(null);
    }
  }, [selectedWorkspace?.id, diffStats]);

  // Initial load on mount with progressive loading
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Polling: Only refresh workspaces and diff stats, no progressive loading
  useEffect(() => {
    const interval = setInterval(async () => {
      // Only refresh workspaces list and update diffs
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        await refreshDiffStats(workspaces);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [loadWorkspaces, refreshDiffStats]);

  useEffect(() => {
    if (showNewWorkspaceModal && repos.length === 0) {
      fetch(`${API_BASE}/repos`)
        .then(res => res.json())
        .then(data => setRepos(data))
        .catch(err => console.error('Failed to load repos:', err));
    }
  }, [showNewWorkspaceModal, repos.length]);

  // Keyboard shortcuts
  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      // ⌘R or Ctrl+R - Refresh workspace data
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        console.log('🔄 Refreshing workspace data...');

        // Refresh workspaces and diffs
        const workspaces = await loadWorkspaces();
        if (workspaces && workspaces.length > 0) {
          await refreshDiffStats(workspaces);
        }

        if (selectedWorkspace) {
          // Reload file changes, PR status, dev servers
          const workspaceId = selectedWorkspace.id;
          fetch(`${API_BASE}/workspaces/${workspaceId}/pr-status`)
            .then(res => res.json())
            .then(data => setPrStatus(data));
          fetch(`${API_BASE}/workspaces/${workspaceId}/dev-servers`)
            .then(res => res.json())
            .then(data => setDevServers(data.servers || []));
          // Clear file changes cache to force reload
          delete fileChangesCache.current[workspaceId];
        }
      }

      // ESC - Close modals
      if (e.key === 'Escape') {
        if (showNewWorkspaceModal) {
          setShowNewWorkspaceModal(false);
        } else if (selectedFile) {
          closeDiffModal();
        } else if (showSystemPromptModal) {
          setShowSystemPromptModal(false);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showNewWorkspaceModal, selectedFile, showSystemPromptModal, selectedWorkspace, loadWorkspaces, refreshDiffStats]);

  /**
   * Toggle repo group collapse state in sidebar
   */
  function toggleRepoCollapse(repoId: string) {
    setCollapsedRepos(prev => {
      const newSet = new Set(prev);
      if (newSet.has(repoId)) {
        newSet.delete(repoId);
      } else {
        newSet.add(repoId);
      }
      return newSet;
    });
  }

  /**
   * Archive a workspace (sets state to 'archived')
   */
  async function archiveWorkspace(workspaceId: string) {
    try {
      const res = await fetch(`${API_BASE}/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'archived' })
      });

      if (!res.ok) {
        throw new Error(`Failed to archive workspace: ${res.statusText}`);
      }

      console.log('✅ Workspace archived');
      // Refresh workspace list without progressive loading
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        await refreshDiffStats(workspaces);
      }
      if (selectedWorkspace?.id === workspaceId) {
        setSelectedWorkspace(null);
      }
    } catch (error) {
      console.error('Error archiving workspace:', error);
      alert(`Error: ${error}`);
    }
  }

  /**
   * Create a new workspace with git worktree
   */
  async function createWorkspace() {
    if (!selectedRepoId) {
      alert('Please select a repository');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch(`${API_BASE}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository_id: selectedRepoId })
      });

      if (!res.ok) {
        throw new Error(`Failed to create workspace: ${res.statusText}`);
      }

      const workspace = await res.json();
      console.log('✅ Workspace created:', workspace.directory_name);

      setSelectedRepoId('');
      setShowNewWorkspaceModal(false);

      // Refresh workspace list and load diff stats for new workspace
      const workspaces = await loadWorkspaces();
      if (workspaces && workspaces.length > 0) {
        await refreshDiffStats(workspaces);
      }
    } catch (error) {
      console.error('Error creating workspace:', error);
      alert(`Error: ${error}`);
    } finally {
      setCreating(false);
    }
  }

  /**
   * Select a workspace to view its details
   */
  function handleWorkspaceClick(workspace: Workspace) {
    setSelectedWorkspace(workspace);
  }

  /**
   * Load and display diff for a specific file
   */
  async function handleFileClick(file: string) {
    if (!selectedWorkspace) return;

    setSelectedFile(file);
    setLoadingDiff(true);
    setFileDiff('');

    try {
      const res = await fetch(`${API_BASE}/workspaces/${selectedWorkspace.id}/diff-file?file=${encodeURIComponent(file)}`);
      const data = await res.json();
      setFileDiff(data.diff || 'No diff available');
    } catch (error) {
      console.error('Failed to load diff:', error);
      setFileDiff('Error loading diff');
    } finally {
      setLoadingDiff(false);
    }
  }

  /**
   * Close the file diff modal
   */
  function closeDiffModal() {
    setSelectedFile(null);
    setFileDiff('');
  }

  /**
   * Open system prompt editor and load current CLAUDE.md
   */
  async function openSystemPromptEditor() {
    if (!selectedWorkspace) return;

    setShowSystemPromptModal(true);
    setLoadingSystemPrompt(true);
    setSystemPrompt('');

    try {
      const res = await fetch(`${API_BASE}/workspaces/${selectedWorkspace.id}/system-prompt`);
      const data = await res.json();
      setSystemPrompt(data.system_prompt || '');
    } catch (error) {
      console.error('Failed to load system prompt:', error);
      alert('Failed to load system prompt');
    } finally {
      setLoadingSystemPrompt(false);
    }
  }

  /**
   * Save system prompt (CLAUDE.md) to workspace
   */
  async function saveSystemPrompt() {
    if (!selectedWorkspace) return;

    setSavingSystemPrompt(true);
    try {
      const res = await fetch(`${API_BASE}/workspaces/${selectedWorkspace.id}/system-prompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_prompt: systemPrompt })
      });

      if (!res.ok) {
        throw new Error('Failed to save system prompt');
      }

      console.log('✅ System prompt saved');
      setShowSystemPromptModal(false);
    } catch (error) {
      console.error('Failed to save system prompt:', error);
      alert('Failed to save system prompt');
    } finally {
      setSavingSystemPrompt(false);
    }
  }

  return (
    <>
      <PanelGroup
        direction="horizontal"
        autoSaveId="conductor-root-layout"
        className="app-container"
        style={{ height: "100%", width: "100%" }}
      >
      {/* LEFT SIDEBAR */}
      <Panel id="left" defaultSize={20} minSize={15} maxSize={35}>
        <div className="panel-content sidebar">
        <div className="sidebar-header">
          <h1>OpenDevs</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => navigate('/settings')}
              className="settings-button"
              title="Settings"
              style={{
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: '4px',
                transition: 'background 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
            >
              ⚙️
            </button>
            <div className="sidebar-status">
              <span className="status-dot"></span>
            </div>
          </div>
        </div>

        <div className="sidebar-controls">
          <button onClick={() => setShowNewWorkspaceModal(true)} className="new-workspace-btn">
            + New Workspace
          </button>
        </div>

        <div className="sidebar-content scrollbar-enhanced">
          {loading ? (
            <div className="loading" style={{ padding: '16px' }}>
              <div className="skeleton skeleton-title" style={{ marginBottom: '12px' }}></div>
              <div className="skeleton skeleton-text" style={{ width: '80%', marginBottom: '12px' }}></div>
              <div className="skeleton skeleton-text" style={{ width: '90%', marginBottom: '12px' }}></div>
              <div className="skeleton skeleton-text" style={{ width: '70%' }}></div>
            </div>
          ) : repoGroups.length === 0 ? (
            <div className="empty-state-enhanced">
              <div className="empty-state-enhanced-icon">📁</div>
              <div className="empty-state-enhanced-title">No Workspaces</div>
              <div className="empty-state-enhanced-description">Create a new workspace to get started on your next project</div>
              <div className="empty-state-enhanced-action">
                <button onClick={() => setShowNewWorkspaceModal(true)} className="btn-enhanced btn-enhanced-primary">
                  <span className="btn-enhanced-icon">+</span>
                  Create Workspace
                </button>
              </div>
            </div>
          ) : (
            repoGroups.map((group) => (
              <RepoGroupComponent
                key={group.repo_id}
                group={group}
                isCollapsed={collapsedRepos.has(group.repo_id)}
                selectedWorkspaceId={selectedWorkspace?.id || null}
                diffStats={diffStats}
                onToggleCollapse={() => toggleRepoCollapse(group.repo_id)}
                onWorkspaceClick={handleWorkspaceClick}
              />
            ))
          )}
        </div>
        </div>
      </Panel>

      <PanelResizeHandle className="resize-handle" />

      {/* MAIN CONTENT */}
      <Panel id="center" minSize={30}>
        <div className="panel-content main-content">
        {selectedWorkspace ? (
          <>
            {/* Compact Header with Workspace Details */}
            <div className="main-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-primary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <h2 className="main-title" style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                    {selectedWorkspace.directory_name}
                  </h2>
                  <span className={`badge-enhanced badge-enhanced-${selectedWorkspace.state === 'ready' ? 'ready' : selectedWorkspace.state === 'initializing' ? 'working' : 'error'}`}>
                    <span className="badge-enhanced-icon">
                      {selectedWorkspace.state === 'ready' ? '✓' : selectedWorkspace.state === 'initializing' ? '⟳' : '•'}
                    </span>
                    {selectedWorkspace.state}
                  </span>
                  {selectedWorkspace.session_status && (
                    <span className={`badge-enhanced badge-enhanced-${selectedWorkspace.session_status === 'working' ? 'working' : 'ready'}`}>
                      <span className="badge-enhanced-icon">
                        {selectedWorkspace.session_status === 'working' ? '⚡' : '✓'}
                      </span>
                      {selectedWorkspace.session_status}
                    </span>
                  )}
                  {prStatus?.has_pr && (
                    <a
                      href={prStatus.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`badge-enhanced badge-enhanced-${prStatus.merge_status === 'ready' ? 'ready' : 'warning'}`}
                      style={{ textDecoration: 'none', cursor: 'pointer' }}
                      title={`PR #${prStatus.pr_number}: ${prStatus.pr_title}`}
                    >
                      <span className="badge-enhanced-icon">🔀</span>
                      PR #{prStatus.pr_number}
                    </a>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    onClick={openSystemPromptEditor}
                    className="btn-enhanced btn-enhanced-primary"
                    style={{ fontSize: '12px', padding: '4px 10px' }}
                    title="Edit system prompt (CLAUDE.md)"
                  >
                    <span className="btn-enhanced-icon">📝</span>
                    System Prompt
                  </button>
                  {compactHandler && (
                    <button
                      onClick={() => compactHandler()}
                      className="btn-enhanced btn-enhanced-primary"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      title="Compact conversation"
                    >
                      <span className="btn-enhanced-icon">📦</span>
                      Compact
                    </button>
                  )}
                  {createPRHandler && (
                    <button
                      onClick={() => createPRHandler()}
                      className="btn-enhanced btn-enhanced-success"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      title="Create pull request"
                    >
                      <span className="btn-enhanced-icon">🔀</span>
                      Create PR
                    </button>
                  )}
                  {stopHandler && selectedWorkspace.session_status === 'working' && (
                    <button
                      onClick={() => stopHandler()}
                      className="btn-enhanced btn-enhanced-error"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      title="Stop session"
                    >
                      <span className="btn-enhanced-icon">⏹</span>
                      Stop
                    </button>
                  )}
                  <button
                    className="btn-enhanced btn-enhanced-error"
                    onClick={() => archiveWorkspace(selectedWorkspace.id)}
                    style={{ fontSize: '12px', padding: '4px 10px' }}
                  >
                    <span className="btn-enhanced-icon">📦</span>
                    Archive
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                <span>{selectedWorkspace.repo_name}</span>
                <span>•</span>
                <span>{selectedWorkspace.branch}</span>
                {selectedWorkspace.context_token_count > 0 && (
                  <>
                    <span>•</span>
                    <span>{formatTokenCount(selectedWorkspace.context_token_count)} tokens</span>
                  </>
                )}
              </div>
            </div>

            {/* Messages take full area */}
            <div className="main-body">
              {selectedWorkspace.active_session_id && (
                <div className="content-section workspace-messages-section" style={{ margin: 0, border: 'none', borderRadius: 0, padding: 0 }}>
                  <div className="section-content" style={{ height: '100%' }}>
                    <WorkspaceDetail
                      workspaceId={selectedWorkspace.id}
                      sessionId={selectedWorkspace.active_session_id}
                      onClose={() => {}}
                      embedded={true}
                      onCompact={(handler) => setCompactHandler(() => handler)}
                      onCreatePR={(handler) => setCreatePRHandler(() => handler)}
                      onStop={(handler) => setStopHandler(() => handler)}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="main-body">
            <div className="empty-state-enhanced animate-fade-in-up">
              <div className="empty-state-enhanced-icon">👈</div>
              <div className="empty-state-enhanced-title">No Workspace Selected</div>
              <div className="empty-state-enhanced-description">
                Select a workspace from the sidebar to view its details and start working
              </div>
            </div>

            {stats && (
              <div className="content-section">
                <h3 className="section-title">Overview</h3>
                <div className="section-content">
                  <p><strong>Workspaces:</strong> {stats.workspaces} ({stats.workspaces_ready} ready, {stats.workspaces_archived} archived)</p>
                  <p><strong>Repositories:</strong> {stats.repos}</p>
                  <p><strong>Sessions:</strong> {stats.sessions} ({stats.sessions_working} working, {stats.sessions_compacting} compacting)</p>
                  <p><strong>Messages:</strong> {stats.messages.toLocaleString()}</p>
                  <p><strong>Status:</strong> {status}</p>
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </Panel>

      <PanelResizeHandle className="resize-handle" />

      {/* RIGHT PANEL - File Changes & Terminal */}
      <Panel id="right" defaultSize={23} minSize={15} maxSize={40}>
        <div className="panel-content right-panel-split">
          {/* Dev Servers Section */}
          {selectedWorkspace && devServers.length > 0 && (
            <div className="right-panel-files" style={{ maxHeight: '150px', minHeight: '100px' }}>
              <div className="right-panel-header">
                <h3 className="right-panel-title">Dev Servers</h3>
              </div>
              <div className="right-panel-content">
                {devServers.map((server, index) => (
                  <a
                    key={index}
                    href={server.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="file-change-item clickable"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                    title={`Open ${server.name} in browser`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '18px' }}>
                        {server.type === 'vite' ? '⚡' :
                         server.type === 'webpack' ? '📦' :
                         server.type === 'angular' ? '🅰️' :
                         server.type === 'node' ? '🟢' : '🌐'}
                      </span>
                      <div>
                        <div className="file-name">{server.name}</div>
                        <div style={{ fontSize: '11px', color: '#9ca3af' }}>{server.url}</div>
                      </div>
                    </div>
                    <div style={{ color: '#10b981', fontSize: '20px' }}>●</div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* File Changes Section */}
          <div className="right-panel-files">
            <div className="right-panel-header">
              <h3 className="right-panel-title">File Changes</h3>
            </div>
            <div className="right-panel-content">
              {selectedWorkspace && fileChanges.length > 0 ? (
                fileChanges.map((file, index) => (
                  <div
                    key={index}
                    className="file-change-item clickable"
                    onClick={() => handleFileClick(file.file)}
                    title="Click to view diff"
                  >
                    <div className="file-name">{file.file}</div>
                    <div className="file-stats">
                      {file.additions > 0 && (
                        <span className="stat-additions">+{file.additions}</span>
                      )}
                      {file.deletions > 0 && (
                        <span className="stat-deletions">-{file.deletions}</span>
                      )}
                    </div>
                  </div>
                ))
              ) : selectedWorkspace ? (
                <div className="empty-state-enhanced">
                  <div className="empty-state-enhanced-icon">✨</div>
                  <div className="empty-state-enhanced-description">No file changes detected</div>
                </div>
              ) : (
                <div className="empty-state-enhanced">
                  <div className="empty-state-enhanced-icon">📄</div>
                  <div className="empty-state-enhanced-description">Select a workspace to view file changes</div>
                </div>
              )}
            </div>
          </div>

          {/* Terminal Section */}
          {selectedWorkspace && (
            <div className="right-panel-terminal">
              <TerminalPanel
                workspacePath={`${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`}
                workspaceName={selectedWorkspace.directory_name}
              />
            </div>
          )}
        </div>
      </Panel>
    </PanelGroup>

      {/* Modals */}
      <NewWorkspaceModal
        show={showNewWorkspaceModal}
        repos={repos}
        selectedRepoId={selectedRepoId}
        creating={creating}
        onClose={() => setShowNewWorkspaceModal(false)}
        onRepoChange={setSelectedRepoId}
        onCreate={createWorkspace}
      />

      <DiffModal
        selectedFile={selectedFile}
        fileDiff={fileDiff}
        loading={loadingDiff}
        onClose={closeDiffModal}
      />

      <SystemPromptModal
        show={showSystemPromptModal && !!selectedWorkspace}
        workspaceName={selectedWorkspace?.directory_name || ""}
        systemPrompt={systemPrompt}
        loading={loadingSystemPrompt}
        saving={savingSystemPrompt}
        onClose={() => setShowSystemPromptModal(false)}
        onChange={setSystemPrompt}
        onSave={saveSystemPrompt}
      />
    </>
  );
}
