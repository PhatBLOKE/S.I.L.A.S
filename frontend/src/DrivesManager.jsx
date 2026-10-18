import React, { useState, useEffect } from 'react';

const API_BASE = '/api';

export default function DrivesManager() {
  const [fleetDrives, setFleetDrives] = useState([]);
  const [activeDrive, setActiveDrive] = useState('E:');
  const [driveData, setDriveData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [subTab, setSubTab] = useState('overview'); // 'overview' | 'root-triage' | 'folder-organizer' | 'duplicates' | 'undo'
  const [statusMsg, setStatusMsg] = useState('');

  // Folder Organizer state
  const [targetPath, setTargetPath] = useState('E:\\PhatBLOKE 3d\\To sort through');
  const [recursive, setRecursive] = useState(true);
  const [folderScanData, setFolderScanData] = useState(null);
  const [selectedCats, setSelectedCats] = useState([]);
  const [folderScanning, setFolderScanning] = useState(false);

  // Duplicates state
  const [dupPath, setDupPath] = useState('E:\\PhatBLOKE 3d\\To sort through');
  const [dupMinSize, setDupMinSize] = useState(1);
  const [dupScanData, setDupScanData] = useState(null);
  const [dupScanning, setDupScanning] = useState(false);
  const [selectedDups, setSelectedDups] = useState([]);

  // Undo history state
  const [undoHistory, setUndoHistory] = useState([]);

  // Modal preview state
  const [previewModal, setPreviewModal] = useState(null);

  const showToast = (msg) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(''), 4500);
  };

  const fetchDrives = async () => {
    try {
      const res = await fetch(`${API_BASE}/drives`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      setFleetDrives(data.drives || []);
      return data.drives || [];
    } catch (err) {
      showToast(`Drive poll error: ${err.message}`);
      return [];
    }
  };

  const inspectDrive = async (driveLetter) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/drive/inspect?drive=${driveLetter}`);
      if (!res.ok) throw new Error('Failed to inspect drive');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      setDriveData(data);
      if (data.presets && data.presets.length > 0) {
        setTargetPath(data.presets[0].path);
        setDupPath(data.presets[0].path);
      } else {
        setTargetPath(`${driveLetter}\\`);
        setDupPath(`${driveLetter}\\`);
      }
    } catch (err) {
      showToast(`Inspect error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchUndoHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/undo/history`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      setUndoHistory(data.history || []);
    } catch (e) {}
  };

  useEffect(() => {
    fetchDrives().then((drives) => {
      if (drives.length > 0) {
        const defaultDrive = drives.find(d => d.drive === 'E:') ? 'E:' : drives[0].drive;
        setActiveDrive(defaultDrive);
        inspectDrive(defaultDrive);
      }
    });
    fetchUndoHistory();
  }, []);

  const handleSelectDrive = (d) => {
    setActiveDrive(d);
    inspectDrive(d);
  };

  // Root Triage
  const handlePreviewRootTriage = async () => {
    try {
      const res = await fetch(`${API_BASE}/root/organize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drive: activeDrive, dry_run: true })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      if (data.count === 0) {
        showToast('No loose clutter files found on drive root.');
        return;
      }
      setPreviewModal({
        title: `Root Triage Simulation for ${activeDrive}\\`,
        count: data.count,
        items: data.planned_moves,
        onConfirm: () => handleExecuteRootTriage()
      });
    } catch (err) {
      showToast(`Root triage preview error: ${err.message}`);
    }
  };

  const handleExecuteRootTriage = async () => {
    setPreviewModal(null);
    try {
      const res = await fetch(`${API_BASE}/root/organize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drive: activeDrive, dry_run: false })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      showToast(`⚡ Cleaned and organized ${data.count} loose root files!`);
      inspectDrive(activeDrive);
      fetchUndoHistory();
    } catch (err) {
      showToast(`Execute error: ${err.message}`);
    }
  };

  // Folder Scan & Organize
  const handleScanFolder = async () => {
    if (!targetPath) return;
    setFolderScanning(true);
    try {
      const res = await fetch(`${API_BASE}/folder/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath, recursive })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Scan failed');
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      setFolderScanData(data);
      setSelectedCats(data.categories.map(c => c.category));
    } catch (err) {
      showToast(`Folder scan error: ${err.message}`);
    } finally {
      setFolderScanning(false);
    }
  };

  const handleOrganizeFolder = async (dryRun = true) => {
    if (!folderScanData || selectedCats.length === 0) {
      showToast('Select at least one category to organize.');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/folder/organize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: folderScanData.path,
          categories: selectedCats,
          dry_run: dryRun
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      if (dryRun) {
        setPreviewModal({
          title: `Folder Organize Simulation (${data.count} files)`,
          count: data.count,
          items: data.planned_moves,
          onConfirm: () => handleOrganizeFolder(false)
        });
      } else {
        setPreviewModal(null);
        showToast(`⚡ Successfully organized ${data.count} files!`);
        handleScanFolder();
        fetchUndoHistory();
      }
    } catch (err) {
      showToast(`Organize error: ${err.message}`);
    }
  };

  // Duplicates Scan
  const handleScanDuplicates = async (sizeMb = dupMinSize) => {
    if (!dupPath) return;
    setDupScanning(true);
    setDupMinSize(sizeMb);
    try {
      const res = await fetch(`${API_BASE}/duplicates/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dupPath, min_size_mb: sizeMb })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      setDupScanData(data);
      // Auto-select clones (skip the first original in each cluster)
      const clones = [];
      (data.clusters || []).forEach(cluster => {
        cluster.files.slice(1).forEach(f => clones.push(f.path));
      });
      setSelectedDups(clones);
    } catch (err) {
      showToast(`Duplicate scan error: ${err.message}`);
    } finally {
      setDupScanning(false);
    }
  };

  const handleQuarantineDuplicates = async () => {
    if (selectedDups.length === 0) {
      showToast('No duplicates selected for quarantine.');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/duplicates/quarantine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drive: activeDrive, files: selectedDups, dry_run: false })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      showToast(`📦 Quarantined ${data.count} duplicate files into ${activeDrive}\\_Duplicates_Quarantine!`);
      handleScanDuplicates(dupMinSize);
      inspectDrive(activeDrive);
      fetchUndoHistory();
    } catch (err) {
      showToast(`Quarantine error: ${err.message}`);
    }
  };

  // Prune Empty Folders
  const handlePruneEmpty = async (foldersToPrune) => {
    try {
      const res = await fetch(`${API_BASE}/empty_folders/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: foldersToPrune, dry_run: false })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      showToast(`Pruned ${data.pruned.length} empty directories.`);
      inspectDrive(activeDrive);
    } catch (err) {
      showToast(`Prune error: ${err.message}`);
    }
  };

  // Undo Revert
  const handleRevert = async (opId) => {
    if (!window.confirm(`Revert operation ${opId}? All files will return to original locations.`)) return;
    try {
      const res = await fetch(`${API_BASE}/undo/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: opId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Request refused (${res.status})`);
      showToast(`↩️ Reverted ${data.reverted_count} files successfully!`);
      inspectDrive(activeDrive);
      fetchUndoHistory();
    } catch (err) {
      showToast(`Revert error: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* HEADER QUIP & STATUS */}
      <div className="hud-panel p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <h2 className="font-display text-base font-bold text-cyan-400 tracking-wider">
              SILAS // MULTI-DRIVE SENTINEL & STORAGE TRIAGE
            </h2>
          </div>
          <p className="font-mono text-xs text-slate-400 mt-1">
            Zero-Fatality storage manager for Karl. Game installations and system kernel structures are locked in stasis.
          </p>
        </div>

        {statusMsg && (
          <div className="text-xs font-mono text-cyan-300 bg-cyan-950/80 border border-cyan-800 px-3 py-1.5 rounded animate-pulse">
            {statusMsg}
          </div>
        )}
      </div>

      {/* MULTI-DRIVE FLEET GRID */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-mono text-xs font-bold text-slate-400 uppercase tracking-wider">
            💽 Hard Drive Fleet Overview ({fleetDrives.length} Drives Detected)
          </h3>
          <button onClick={fetchDrives} className="hud-btn text-xs py-1 px-3">
            🔄 Rescan Fleet
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {fleetDrives.map((d) => {
            const isActive = d.drive.toUpperCase() === activeDrive.toUpperCase();
            return (
              <div
                key={d.drive}
                onClick={() => handleSelectDrive(d.drive)}
                className={`hud-panel p-4 cursor-pointer transition-all duration-200 border-2 ${
                  isActive
                    ? 'border-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.3)] bg-cyan-950/20'
                    : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded bg-slate-900 border border-slate-700 flex items-center justify-center font-bold text-base text-cyan-400 font-mono">
                      {d.letter}
                    </div>
                    <div>
                      <div className="font-bold text-sm text-white font-mono">{d.drive} {d.name}</div>
                      <div className="text-[10px] text-slate-400 uppercase tracking-wider">{d.type}</div>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                      d.status === 'critical'
                        ? 'bg-red-950 text-red-300 border border-red-800'
                        : d.status === 'warning'
                        ? 'bg-amber-950 text-amber-300 border border-amber-800'
                        : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    }`}
                  >
                    {d.status === 'warning' ? 'Low Free Space' : d.status}
                  </span>
                </div>

                {/* Progress bar */}
                <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden my-3">
                  <div
                    className={`h-full transition-all duration-300 ${
                      d.status === 'critical' ? 'bg-red-500' : d.status === 'warning' ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    style={{ width: `${d.percent_used}%` }}
                  ></div>
                </div>

                <div className="flex justify-between text-xs font-mono text-slate-300">
                  <span>Used: <b>{d.used_str}</b> ({d.percent_used}%)</span>
                  <span className={d.status !== 'healthy' ? 'text-amber-400 font-bold' : 'text-emerald-400'}>
                    Free: <b>{d.free_str}</b>
                  </span>
                </div>

                <div className="mt-2 pt-2 border-t border-slate-800/80 flex justify-between items-center text-[10px] font-mono">
                  <span className="text-slate-500">Total: {d.total_str}</span>
                  <span className={isActive ? 'text-cyan-400 font-bold' : 'text-slate-500'}>
                    {isActive ? '● ACTIVE TARGET' : 'CLICK TO SELECT'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ACTIVE DRIVE SUMMARY & METRICS */}
      {driveData && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="hud-panel p-4">
            <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
              Occupied ({activeDrive})
            </div>
            <div className="text-xl font-bold font-mono text-white">{driveData.used_str}</div>
            <div className="text-[11px] text-amber-400 font-mono mt-1">{driveData.percent_used}% capacity used</div>
          </div>

          <div className="hud-panel p-4">
            <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
              Available Free Space
            </div>
            <div className="text-xl font-bold font-mono text-emerald-400">{driveData.free_str}</div>
            <div className="text-[11px] text-slate-400 font-mono mt-1">SSD health headroom</div>
          </div>

          <div className="hud-panel p-4">
            <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
              Safety Shield Status
            </div>
            <div className="text-xl font-bold font-mono text-cyan-400">ACTIVE</div>
            <div className="text-[11px] text-slate-400 font-mono mt-1">Games & Kernel Locked</div>
          </div>

          <div className="hud-panel p-4">
            <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
              Loose Root Clutter
            </div>
            <div className="text-xl font-bold font-mono text-purple-400">
              {driveData.loose_files ? driveData.loose_files.filter(f => !f.protected).length : 0} Files
            </div>
            <div className="text-[11px] text-slate-400 font-mono mt-1">Ready for clean triage</div>
          </div>
        </div>
      )}

      {/* STORAGE SUB-NAV TABS */}
      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setSubTab('overview')}
          className={`hud-btn text-xs py-2 px-4 ${subTab === 'overview' ? 'hud-btn-primary' : ''}`}
        >
          🛡️ OVERVIEW & MATRIX
        </button>
        <button
          onClick={() => setSubTab('root-triage')}
          className={`hud-btn text-xs py-2 px-4 ${subTab === 'root-triage' ? 'hud-btn-primary' : ''}`}
        >
          🧹 ROOT CLUTTER FIXER
        </button>
        <button
          onClick={() => setSubTab('folder-organizer')}
          className={`hud-btn text-xs py-2 px-4 ${subTab === 'folder-organizer' ? 'hud-btn-primary' : ''}`}
        >
          📂 DEEP FOLDER ORGANIZER
        </button>
        <button
          onClick={() => setSubTab('duplicates')}
          className={`hud-btn text-xs py-2 px-4 ${subTab === 'duplicates' ? 'hud-btn-primary' : ''}`}
        >
          👯 DUPLICATE HUNTER
        </button>
        <button
          onClick={() => { setSubTab('undo'); fetchUndoHistory(); }}
          className={`hud-btn text-xs py-2 px-4 ${subTab === 'undo' ? 'hud-btn-primary' : ''}`}
        >
          ↩️ UNDO AUDIT JOURNAL
        </button>
      </div>

      {/* SUB-PANEL 1: OVERVIEW & SAFETY MATRIX */}
      {subTab === 'overview' && driveData && (
        <div className="hud-panel p-5 space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="font-display font-bold text-sm text-white">
                SECURITY & DIRECTORY MATRIX FOR DRIVE {activeDrive}\
              </h3>
              <p className="font-mono text-xs text-slate-400 mt-0.5">
                Critical game directories and Windows files are protected from accidental modifications.
              </p>
            </div>
            {driveData.empty_folders && driveData.empty_folders.length > 0 && (
              <button
                onClick={() => handlePruneEmpty(driveData.empty_folders.map(f => f.path))}
                className="hud-btn text-xs py-1.5 px-3 bg-red-950/80 border-red-700 text-red-300 hover:bg-red-900"
              >
                🗑️ Prune {driveData.empty_folders.length} Ghost Folders
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">Directory / Target</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Last Modified</th>
                  <th className="py-2.5 px-3">Safety Policy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {driveData.folders.map((f) => (
                  <tr key={f.name} className="hover:bg-slate-900/40">
                    <td className={`py-2 px-3 font-bold ${f.protected ? 'text-blue-300' : 'text-slate-200'}`}>
                      {f.protected ? '📁' : (f.is_empty ? '📭' : '📂')} {f.name}
                    </td>
                    <td className="py-2 px-3 text-slate-400">{f.category}</td>
                    <td className="py-2 px-3">
                      <span
                        className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${
                          f.protected
                            ? 'bg-blue-950 text-blue-300 border border-blue-800'
                            : f.is_empty
                            ? 'bg-amber-950 text-amber-300 border border-amber-800'
                            : 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                        }`}
                      >
                        {f.protected ? 'PROTECTED' : (f.is_empty ? 'EMPTY GHOST' : 'ACTIVE')}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-400">{f.mtime}</td>
                    <td className="py-2 px-3">
                      {f.protected ? (
                        <span className="text-blue-400 font-bold">🔒 Locked (Immune)</span>
                      ) : f.is_empty ? (
                        <button
                          onClick={() => handlePruneEmpty([f.path])}
                          className="hud-btn text-[10px] py-0.5 px-2 bg-red-950 text-red-300 border-red-800"
                        >
                          Delete Empty
                        </button>
                      ) : (
                        <span className="text-slate-500">Triage Eligible</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-PANEL 2: ROOT CLUTTER FIXER */}
      {subTab === 'root-triage' && driveData && (
        <div className="hud-panel p-5 space-y-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
            <div>
              <h3 className="font-display font-bold text-sm text-white">
                ROOT CLUTTER RESOLVER ({activeDrive}\)
              </h3>
              <p className="font-mono text-xs text-slate-400 mt-0.5">
                Identifies loose firmware files, installers, and shortcuts dumped on root and batches them into clean folders.
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={handlePreviewRootTriage} className="hud-btn text-xs py-1.5 px-4 hud-btn-primary">
                👁️ Preview Simulation (Dry Run)
              </button>
              <button
                onClick={handleExecuteRootTriage}
                className="hud-btn text-xs py-1.5 px-4 bg-emerald-950 border-emerald-700 text-emerald-300 hover:bg-emerald-900"
              >
                ⚡ Execute Reorganize
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">File Name</th>
                  <th className="py-2.5 px-3">Size</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3">Target Folder</th>
                  <th className="py-2.5 px-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {driveData.loose_files && driveData.loose_files.length > 0 ? (
                  driveData.loose_files.map((f) => {
                    let target = 'Left Untouched';
                    if (!f.protected) {
                      if (f.category.includes('Firmware')) target = `${activeDrive}\\_Firmware_and_3D`;
                      else if (f.category.includes('Installers')) target = `${activeDrive}\\_Installers`;
                      else if (f.category.includes('Shortcuts')) target = `${activeDrive}\\_Shortcuts`;
                      else target = `${activeDrive}\\_${f.category.replace(/[^a-zA-Z0-9]/g, '_')}`;
                    }
                    return (
                      <tr key={f.name} className="hover:bg-slate-900/40">
                        <td className="py-2 px-3 font-bold text-slate-200">{f.name}</td>
                        <td className="py-2 px-3 text-slate-400">{f.size_str}</td>
                        <td className="py-2 px-3 text-slate-400">{f.category}</td>
                        <td className="py-2 px-3 text-cyan-400 font-bold">{target}</td>
                        <td className="py-2 px-3">
                          {f.protected ? (
                            <span className="text-[9px] px-2 py-0.5 rounded font-bold uppercase bg-blue-950 text-blue-300 border border-blue-800">
                              Locked Kernel File
                            </span>
                          ) : (
                            <span className="text-[9px] px-2 py-0.5 rounded font-bold uppercase bg-amber-950 text-amber-300 border border-amber-800">
                              Loose Clutter
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan="5" className="py-6 text-center text-slate-500 font-mono">
                      No loose clutter files in the root of {activeDrive}\.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-PANEL 3: DEEP FOLDER ORGANIZER */}
      {subTab === 'folder-organizer' && (
        <div className="hud-panel p-5 space-y-4">
          <div>
            <h3 className="font-display font-bold text-sm text-white">
              DEEP FOLDER TRIAGE & EXTENSION CATEGORIZER
            </h3>
            <p className="font-mono text-xs text-slate-400 mt-0.5">
              Select any chaotic directory and organize files into dedicated buckets (3D Models, Slices, Firmware, Zips).
            </p>
          </div>

          {/* Quick Presets */}
          {driveData && driveData.presets && (
            <div>
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block mb-1">
                DRIVE PRESETS:
              </span>
              <div className="flex flex-wrap gap-2">
                {driveData.presets.map((p) => (
                  <button
                    key={p.path}
                    onClick={() => {
                      setTargetPath(p.path);
                      setDupPath(p.path);
                    }}
                    className="hud-btn text-xs py-1 px-2.5 font-mono"
                  >
                    📂 {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Path Input */}
          <div className="flex flex-col md:flex-row gap-2">
            <input
              type="text"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="Absolute folder path (e.g. E:\PhatBLOKE 3d\To sort through)"
              className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-white font-mono text-xs"
            />
            <button
              onClick={handleScanFolder}
              disabled={folderScanning}
              className="hud-btn text-xs py-2 px-5 hud-btn-primary font-bold font-mono"
            >
              {folderScanning ? 'SCANNING...' : '🔍 SCAN & ANALYZE'}
            </button>
          </div>

          <div className="flex items-center gap-4 text-xs font-mono text-slate-400">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
                className="accent-cyan-400"
              />
              Scan Subfolders (Recursive)
            </label>
          </div>

          {/* Category Results */}
          {folderScanData && (
            <div className="space-y-4 pt-3 border-t border-slate-800">
              <div className="flex justify-between items-center">
                <span className="font-mono text-xs text-slate-300">
                  Discovered <b>{folderScanData.total_files} files</b> ({folderScanData.total_size_str})
                </span>
                <div className="flex gap-2">
                  <button onClick={() => handleOrganizeFolder(true)} className="hud-btn text-xs py-1.5 px-3">
                    👁️ Preview Move (Dry Run)
                  </button>
                  <button
                    onClick={() => handleOrganizeFolder(false)}
                    className="hud-btn text-xs py-1.5 px-4 hud-btn-primary font-bold font-mono"
                  >
                    🚀 Organize Selected
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {folderScanData.categories.map((cat) => {
                  const isChecked = selectedCats.includes(cat.category);
                  return (
                    <div
                      key={cat.category}
                      className={`hud-panel p-3 border ${isChecked ? 'border-cyan-500/60' : 'border-slate-800'}`}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <label className="flex items-center gap-2 font-mono text-xs font-bold text-white cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedCats([...selectedCats, cat.category]);
                              else setSelectedCats(selectedCats.filter(c => c !== cat.category));
                            }}
                            className="accent-cyan-400"
                          />
                          {cat.category}
                        </label>
                        <span className="text-[10px] bg-cyan-950 text-cyan-300 px-1.5 py-0.5 rounded font-mono">
                          {cat.count} files
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 flex justify-between">
                        <span>Total: {cat.total_size_str}</span>
                        <span className="text-cyan-400">→ _{cat.category.replace(/[^a-zA-Z0-9]/g, '_')}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {cat.sample_files.slice(0, 3).map((f) => (
                          <span key={f.path} className="text-[9px] bg-slate-900 text-slate-400 px-1.5 py-0.5 rounded font-mono truncate max-w-[120px]" title={f.name}>
                            {f.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUB-PANEL 4: DUPLICATE HUNTER */}
      {subTab === 'duplicates' && (
        <div className="hud-panel p-5 space-y-4">
          <div>
            <h3 className="font-display font-bold text-sm text-white">
              BYTE-FOR-BYTE DUPLICATE HUNTER (CHUNK MD5 + SHA-256)
            </h3>
            <p className="font-mono text-xs text-slate-400 mt-0.5">
              Identifies identical duplicate files across nested folders and moves redundant copies into quarantine.
            </p>
          </div>

          <div className="flex flex-col md:flex-row gap-2">
            <input
              type="text"
              value={dupPath}
              onChange={(e) => setDupPath(e.target.value)}
              placeholder="Target folder path for duplicate scan"
              className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-white font-mono text-xs"
            />
            <button
              onClick={() => handleScanDuplicates()}
              disabled={dupScanning}
              className="hud-btn text-xs py-2 px-5 hud-btn-primary font-bold font-mono"
            >
              {dupScanning ? 'HASHING...' : '🔎 HUNT DUPLICATES'}
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
            <span>Min Size Filter:</span>
            <button onClick={() => handleScanDuplicates(1)} className={`hud-btn text-xs py-0.5 px-2 ${dupMinSize === 1 ? 'hud-btn-primary' : ''}`}>
              &gt; 1 MB
            </button>
            <button onClick={() => handleScanDuplicates(10)} className={`hud-btn text-xs py-0.5 px-2 ${dupMinSize === 1 ? '' : dupMinSize === 10 ? 'hud-btn-primary' : ''}`}>
              &gt; 10 MB
            </button>
            <button onClick={() => handleScanDuplicates(50)} className={`hud-btn text-xs py-0.5 px-2 ${dupMinSize === 50 ? 'hud-btn-primary' : ''}`}>
              &gt; 50 MB
            </button>
          </div>

          {dupScanData && (
            <div className="space-y-4 pt-3 border-t border-slate-800">
              <div className="flex justify-between items-center">
                <span className="font-mono text-xs text-slate-300">
                  Discovered <b>{dupScanData.duplicate_sets} duplicate clusters</b> wasting{' '}
                  <b className="text-amber-400">{dupScanData.total_wasted_str}</b>
                </span>
                <button
                  onClick={handleQuarantineDuplicates}
                  className="hud-btn text-xs py-1.5 px-4 bg-amber-950 border-amber-700 text-amber-300 hover:bg-amber-900 font-bold font-mono"
                >
                  📦 Move {selectedDups.length} Clones to _Quarantine
                </button>
              </div>

              <div className="space-y-3">
                {dupScanData.clusters.map((c) => (
                  <div key={c.hash} className="hud-panel p-3 border border-slate-800">
                    <div className="flex justify-between items-center mb-2 font-mono text-xs">
                      <span className="font-bold text-white">{c.files[0].name}</span>
                      <span className="text-amber-400 font-bold bg-amber-950/60 px-2 py-0.5 rounded border border-amber-800/60 text-[10px]">
                        Wasting {c.wasted_str}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      {c.files.map((f, i) => {
                        const isSelected = selectedDups.includes(f.path);
                        return (
                          <div key={f.path} className="flex justify-between items-center text-xs font-mono p-1 bg-slate-900/50 rounded">
                            <label className="flex items-center gap-2 text-slate-300 cursor-pointer truncate max-w-[80%]">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => {
                                  if (e.target.checked) setSelectedDups([...selectedDups, f.path]);
                                  else setSelectedDups(selectedDups.filter(p => p !== f.path));
                                }}
                                className="accent-cyan-400"
                              />
                              <span className="truncate">{f.path}</span>
                            </label>
                            <span className="text-[10px] text-slate-500 whitespace-nowrap">
                              {i === 0 ? '⭐ Original' : 'Clone'} ({f.mtime})
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUB-PANEL 5: UNDO AUDIT JOURNAL */}
      {subTab === 'undo' && (
        <div className="hud-panel p-5 space-y-4">
          <div>
            <h3 className="font-display font-bold text-sm text-white">
              UNDO AUDIT JOURNAL & INSTANT ROLLBACK
            </h3>
            <p className="font-mono text-xs text-slate-400 mt-0.5">
              Every single file movement or quarantine action is logged. Click Revert to restore files immediately.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">Operation ID</th>
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Action Performed</th>
                  <th className="py-2.5 px-3">Files Shifted</th>
                  <th className="py-2.5 px-3">Rollback Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {undoHistory.length > 0 ? (
                  undoHistory.slice().reverse().map((op) => (
                    <tr key={op.id} className="hover:bg-slate-900/40">
                      <td className="py-2 px-3 text-cyan-400 font-bold">{op.id}</td>
                      <td className="py-2 px-3 text-slate-400">{op.timestamp}</td>
                      <td className="py-2 px-3 text-slate-200 font-bold">{op.action}</td>
                      <td className="py-2 px-3 text-slate-300">{op.count} files</td>
                      <td className="py-2 px-3">
                        <button
                          onClick={() => handleRevert(op.id)}
                          className="hud-btn text-[10px] py-1 px-3 bg-red-950/80 border-red-700 text-red-300 hover:bg-red-900"
                        >
                          ↩️ Revert Operation
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="5" className="py-6 text-center text-slate-500 font-mono">
                      No operations recorded yet. Your hard drives are completely untouched.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: PREVIEW SIMULATION */}
      {previewModal && (
        <div className="modal-overlay" onClick={() => setPreviewModal(null)}>
          <div className="modal-content p-6 max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center pb-3 border-b border-slate-800 mb-3">
              <h3 className="font-display font-bold text-sm text-cyan-400">
                {previewModal.title}
              </h3>
              <button onClick={() => setPreviewModal(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 font-mono text-xs pr-2">
              <p className="text-slate-300 mb-2">
                Simulated {previewModal.count} planned actions. Review the target paths below:
              </p>
              <table className="w-full text-left">
                <thead className="bg-slate-900 text-slate-400 text-[10px] uppercase">
                  <tr>
                    <th className="p-1.5">File</th>
                    <th className="p-1.5">Destination</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {previewModal.items.slice(0, 40).map((m, idx) => (
                    <tr key={idx} className="hover:bg-slate-900/50">
                      <td className="p-1.5 text-slate-200">{m.name}</td>
                      <td className="p-1.5 text-cyan-400 truncate max-w-xs">{m.dst}</td>
                    </tr>
                  ))}
                  {previewModal.items.length > 40 && (
                    <tr>
                      <td colSpan="2" className="p-2 text-center text-slate-500">
                        ...and {previewModal.items.length - 40} more files
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-3">
              <button onClick={() => setPreviewModal(null)} className="hud-btn text-xs py-1.5 px-4">
                Cancel
              </button>
              <button
                onClick={previewModal.onConfirm}
                className="hud-btn text-xs py-1.5 px-4 hud-btn-primary font-bold font-mono"
              >
                Confirm & Execute Move
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
