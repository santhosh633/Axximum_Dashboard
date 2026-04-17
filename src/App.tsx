/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend, Cell
} from 'recharts';
import { 
  LayoutDashboard, Plus, Settings, RefreshCcw, Database, Table as TableIcon, 
  BarChart3, User, LogOut, ChevronRight, ExternalLink, Search, Filter, 
  FileSpreadsheet, AlertCircle, ChartLine, FileText, UserCheck, Rocket,
  Brain, Trophy, CheckCircle2, History, Link as LinkIcon, Unlink, Info, X, XCircle,
  Clock, CheckCircle, AlertTriangle, CloudUpload, Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db } from './firebase';
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { 
  collection, query, where, onSnapshot, doc, setDoc, updateDoc, deleteDoc,
  disableNetwork, enableNetwork 
} from 'firebase/firestore';
import { GoogleGenAI, Type } from "@google/genai";
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import Markdown from 'react-markdown';
import axios from 'axios';
import { Project } from './types';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
  }
}

// Constants for theme
const THEME = {
  blue: '#0078d4',
  light: '#60a5fa',
  dark: '#1e3a5f',
  green: '#10b981',
  purple: '#8b5cf6',
  orange: '#f59e0b',
  bgGradient: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
};

type TabId = '__overview__' | '__pages__' | '__attendance__' | '__syncmanager__' | '__today_target__' | string;

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('__overview__');
  const [syncing, setSyncing] = useState(false);
  const [projectSyncStatus, setProjectSyncStatus] = useState<Record<string, 'idle' | 'syncing' | 'error' | 'success'>>({});
  const [syncLog, setSyncLog] = useState<{name: string, type: 'success' | 'error' | 'warn', message: string, time: string}[]>([]);
  const [syncIntervalMs, setSyncIntervalMs] = useState(300000);
  const [countdown, setCountdown] = useState(100);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectUrl, setNewProjectUrl] = useState('');
  const [quotaExhausted, setQuotaExhausted] = useState(() => {
    try {
      const stored = localStorage.getItem('ax_quota_ex');
      if (!stored) return false;
      const { d, v } = JSON.parse(stored);
      return d === new Date().toDateString() ? v : false;
    } catch { return false; }
  });

  useEffect(() => {
    localStorage.setItem('ax_quota_ex', JSON.stringify({ d: new Date().toDateString(), v: quotaExhausted }));
  }, [quotaExhausted]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);

  // 1. Auth Listener and Init Quota Guard
  useEffect(() => {
    if (quotaExhausted) {
      disableNetwork(db).catch(console.error);
    }
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  const handleFirestoreError = useCallback((error: unknown, operationType: OperationType, path: string | null) => {
    const errMessage = error instanceof Error ? error.message : String(error);
    const isQuota = errMessage.toLowerCase().includes('resource-exhausted') || 
                  errMessage.toLowerCase().includes('quota limit exceeded') ||
                  errMessage.toLowerCase().includes('quota exceeded');
    
    if (isQuota) {
      setQuotaExhausted(true);
      disableNetwork(db).catch(console.error);
    }

    const errInfo: FirestoreErrorInfo = {
      error: errMessage,
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
        isAnonymous: auth.currentUser?.isAnonymous,
      },
      operationType,
      path
    };
    console.error('Firestore Error: ', errInfo);
    return new Error(JSON.stringify(errInfo));
  }, []);

  // 2. Data Listener
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'projects'), where('uid', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const projList = snapshot.docs.map(doc => ({ ...doc.data() } as Project));
      setProjects(projList);
    }, (error) => {
      const handled = handleFirestoreError(error, OperationType.LIST, 'projects');
      addLog('System', 'error', `Database Error: ${handled.message}`);
    });
    return () => unsubscribe();
  }, [user, handleFirestoreError]);

  // 3. Independent Auto-Sync Logic
  const syncTimers = useRef<Record<string, NodeJS.Timeout>>({});
  const syncTimeouts = useRef<Record<string, NodeJS.Timeout>>({});

  useEffect(() => {
    if (!user || quotaExhausted) {
      if (quotaExhausted) {
        Object.values(syncTimers.current).forEach(clearInterval);
        Object.values(syncTimeouts.current).forEach(clearTimeout);
        syncTimers.current = {};
        syncTimeouts.current = {};
      }
      return;
    }

    const projectsWithUrl = projects.filter(p => p.sheetUrl);
    const activeIds = new Set(projectsWithUrl.map(p => p.id));

    // Cleanup: Clear timers for projects that no longer have a URL or were deleted
    Object.keys(syncTimers.current).forEach(id => {
      if (!activeIds.has(id)) {
        clearInterval(syncTimers.current[id]);
        delete syncTimers.current[id];
      }
    });

    Object.keys(syncTimeouts.current).forEach(id => {
      if (!activeIds.has(id)) {
        clearTimeout(syncTimeouts.current[id]);
        delete syncTimeouts.current[id];
      }
    });

    // Initialization/Update: Ensure every project with a URL has its own timer
    projectsWithUrl.forEach((project, index) => {
      if (!syncTimers.current[project.id] && !syncTimeouts.current[project.id]) {
        // Offset starting times slightly to avoid a burst of requests if many projects exist
        const offset = (index % 10) * 1000; 
        syncTimeouts.current[project.id] = setTimeout(() => {
          // Re-check existence as state might have changed during timeout
          const currentP = projects.find(p => p.id === project.id);
          if (currentP?.sheetUrl && !syncTimers.current[currentP.id] && !quotaExhausted) {
              syncProject(currentP, false);
              syncTimers.current[currentP.id] = setInterval(() => {
                syncProject(currentP, false);
              }, syncIntervalMs);
          }
          delete syncTimeouts.current[project.id];
        }, offset);
      }
    });

    setCountdown(100);
    const countdownTimer = setInterval(() => {
      setCountdown(prev => Math.max(0, prev - (1000 / syncIntervalMs * 100)));
    }, 1000);

    return () => {
      clearInterval(countdownTimer);
    };
  }, [user, projects.length, syncIntervalMs, quotaExhausted]);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      Object.values(syncTimers.current).forEach(clearInterval);
    };
  }, []);

  const addLog = (name: string, type: 'success' | 'error' | 'warn', message: string) => {
    const time = new Date().toLocaleTimeString();
    setSyncLog(prev => [{ name, type, message, time }, ...prev].slice(0, 50));
  };

  const handleManualUpload = (e: React.ChangeEvent<HTMLInputElement>, projectId?: string) => {
    const file = e.target.files?.[0];
    if (!file || !user || quotaExhausted) return;

    const currentProjectId = projectId || targetProjectId;
    if (!currentProjectId) return;

    const project = projects.find(p => p.id === currentProjectId);
    if (!project) return;

    setProjectSyncStatus(prev => ({ ...prev, [currentProjectId]: 'syncing' }));

    const reader = new FileReader();

    const processResults = async (results: any[]) => {
      if (!results || results.length === 0) {
        addLog(project.name, 'warn', 'Uploaded file contains no data');
        setProjectSyncStatus(prev => ({ ...prev, [currentProjectId]: 'error' }));
        return;
      }

      const sanitizedData = results.slice(0, 5000).map((row: any) => {
        const clean: any = {};
        Object.keys(row).forEach(key => {
          const cleanedKey = key.trim().replace(/\./g, '_');
          if (cleanedKey && row[key] !== undefined && row[key] !== null) {
            clean[cleanedKey] = row[key];
          }
        });
        return clean;
      }).filter(row => Object.keys(row).length > 0);

      if (quotaExhausted) return;
      try {
        await updateDoc(doc(db, 'projects', currentProjectId), {
          data: sanitizedData,
          lastSynced: new Date().toISOString()
        });
        addLog(project.name, 'success', `Manually ingested ${results.length} rows from ${file.name}`);
        setProjectSyncStatus(prev => ({ ...prev, [currentProjectId]: 'success' }));
        setTimeout(() => setProjectSyncStatus(prev => ({ ...prev, [currentProjectId]: 'idle' })), 3000);
      } catch (err: any) {
        handleFirestoreError(err, OperationType.UPDATE, `projects/${currentProjectId}`);
      }
    };

    if (file.name.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => processResults(results.data),
        error: (err) => addLog(project.name, 'error', `CSV Parsing Error: ${err.message}`)
      });
    } else {
      reader.onload = (event) => {
        try {
          const workbook = XLSX.read(event.target?.result, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const data = XLSX.utils.sheet_to_json(sheet);
          processResults(data);
        } catch (err: any) {
          addLog(project.name, 'error', `Excel Parsing Error: ${err.message}`);
        }
      };
      reader.readAsBinaryString(file);
    }
  };

  const syncProject = async (project: Project, manual = true) => {
    if (!project.sheetUrl || quotaExhausted) {
      if (quotaExhausted) {
        addLog(project.name, 'warn', 'Sync skipped: Firestore quota limit reached for today');
      }
      return;
    }
    if (manual) setSyncing(true);
    setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'syncing' }));

    try {
      // Use the server proxy to avoid CORS
      const response = await axios.get(`/api/fetch-sheet?url=${encodeURIComponent(project.sheetUrl)}`, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      
      Papa.parse(response.data, {
        header: true,
        skipEmptyLines: true,
        complete: async (results) => {
          if (!results.data || results.data.length === 0) {
            addLog(project.name, 'warn', 'Sheet parsed but contains no data');
            setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'error' }));
            if (manual) setSyncing(false);
            return;
          }

          // Deep clean data to prevent Firestore "empty fields" or invalid key errors
          const sanitizedData = results.data.slice(0, 2000).map((row: any) => {
            const clean: any = {};
            Object.keys(row).forEach(key => {
              const cleanedKey = key.trim().replace(/\./g, '_');
              if (cleanedKey && row[key] !== undefined && row[key] !== null) {
                clean[cleanedKey] = row[key];
              }
            });
            return clean;
          }).filter(row => Object.keys(row).length > 0);

          // DATA DELTA CHECK: Prevent redundant writes to save quota
          const currentDataStr = JSON.stringify(project.data || []);
          const newDataStr = JSON.stringify(sanitizedData);
          
          if (currentDataStr === newDataStr) {
            addLog(project.name, 'success', `No changes detected in source (${results.data.length} rows)`);
            setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'success' }));
            setTimeout(() => setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'idle' })), 3000);
            if (manual) setSyncing(false);
            return;
          }

          if (quotaExhausted) return;
          try {
            await updateDoc(doc(db, 'projects', project.id), {
              data: sanitizedData,
              lastSynced: new Date().toISOString()
            });
          } catch (err: any) {
            handleFirestoreError(err, OperationType.UPDATE, `projects/${project.id}`);
            throw err;
          }
          addLog(project.name, 'success', `Successfully ingested ${results.data.length} data rows`);
          setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'success' }));
          
          // Reset to idle after 3s
          setTimeout(() => {
            setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'idle' }));
          }, 3000);

          if (manual) setSyncing(false);
        },
        error: (err) => {
          addLog(project.name, 'error', `Parsing Error: ${err.message}`);
          setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'error' }));
          if (manual) setSyncing(false);
        }
      });
    } catch (err: any) {
      const errorMsg = err.response?.data?.details || err.response?.data?.error || err.message;
      addLog(project.name, 'error', `Network/Proxy Error: ${errorMsg}`);
      setProjectSyncStatus(prev => ({ ...prev, [project.id]: 'error' }));
      if (manual) setSyncing(false);
    }
  };

  const login = async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  const logout = () => signOut(auth);

  const addNewSource = async () => {
    if (!user || quotaExhausted) {
      if (quotaExhausted) addLog('System', 'error', 'Quota exceeded. Cannot create new source right now.');
      return;
    }
    if (!newProjectName.trim()) {
      addLog('System', 'error', 'Source Name is required to register a project');
      return;
    }
    
    const id = Date.now().toString();
    const newProj: Project = {
      id,
      name: newProjectName.trim(),
      sheetUrl: newProjectUrl.trim(),
      uid: user.uid,
      data: []
    };
    
    try {
      await setDoc(doc(db, 'projects', id), newProj);
      addLog(newProj.name, 'success', 'User activity tracking project initialized');
      
      // Trigger immediate sync if URL is provided
      if (newProjectUrl.trim()) {
        syncProject(newProj, true);
      } else {
        addLog(newProj.name, 'warn', 'Awaiting activity data via Manual Upload or Sheet Link');
      }

      setNewProjectName('');
      setNewProjectUrl('');
      setShowNewProjectModal(false);
      setActiveTab(id);
    } catch (err: any) {
      const handled = handleFirestoreError(err, OperationType.CREATE, `projects/${id}`);
      addLog('System', 'error', `Database Error: ${handled.message}`);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#0f172a]" style={{ background: THEME.bgGradient }}>
      <RefreshCcw className="animate-spin text-axx-blue w-12 h-12" />
    </div>
  );

  if (!user) return (
    <div className="min-h-screen flex items-center justify-center bg-[#0f172a] p-6" style={{ background: THEME.bgGradient }}>
      <div className="absolute inset-0 opacity-20 pointer-events-none overflow-hidden">
         <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-axx-blue blur-[128px] rounded-full"></div>
         <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-axx-purple blur-[128px] rounded-full" ></div>
      </div>

      <div className="relative z-10 w-full max-w-[420px] bg-axx-slate-800/90 backdrop-blur-2xl border border-axx-blue/30 rounded-[24px] p-12 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-3 mb-8">
            <div className="relative w-10 h-10">
              <div className="absolute top-0 left-0 w-6 h-6 bg-axx-blue rounded-[6px] animate-[float_3s_ease-in-out_infinite]"></div>
              <div className="absolute bottom-0 right-0 w-5 h-5 bg-axx-light rounded-full animate-[float_3s_ease-in-out_1.5s_infinite]"></div>
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-xl font-extrabold text-white tracking-tight">Axx<span className="text-axx-light">imum</span></span>
              <span className="text-[10px] text-slate-500 uppercase tracking-widest">Where innovation meets intelligence</span>
            </div>
        </div>

        <h2 className="text-2xl font-bold text-white mb-2">Welcome Back</h2>
        <p className="text-slate-400 text-sm mb-6">Sign in to access your analytics dashboard</p>

        <div className="space-y-4">
          <input 
            type="email" 
            placeholder="Email address" 
            className="w-full bg-black/40 border border-white/10 rounded-[10px] p-4 text-white text-sm focus:outline-none focus:border-axx-blue transition-all"
          />
          <input 
            type="password" 
            placeholder="Password" 
            className="w-full bg-black/40 border border-white/10 rounded-[10px] p-4 text-white text-sm focus:outline-none focus:border-axx-blue transition-all"
          />
          <button 
            onClick={login}
            className="w-full py-4 bg-gradient-to-r from-axx-blue to-axx-light text-white font-bold rounded-[10px] flex items-center justify-center gap-2 hover:translate-y-[-2px] transition-all shadow-lg shadow-axx-blue/20"
          >
            <Zap size={18} fill="white" /> Sign In
          </button>
          <button 
            onClick={login}
            className="w-full py-4 bg-white/5 text-slate-300 font-bold rounded-[10px] flex items-center justify-center gap-2 hover:bg-white/10 transition-all border border-white/5"
          >
            <Zap size={18} className="text-axx-light" /> Quick Demo Access
          </button>
        </div>

        <div className="mt-8 text-center text-slate-500 text-sm">
          Don't have an account? <span className="text-axx-light font-bold cursor-pointer hover:underline">Register here</span>
        </div>
        <div className="mt-2 text-center">
          <span className="text-axx-light text-sm font-bold cursor-pointer hover:underline">Forgot password?</span>
        </div>

        {/* Developer Attribution */}
        <div className="mt-12 pt-8 border-t border-white/5 text-center">
            <p className="text-[10px] uppercase tracking-widest text-slate-500">this app devloped by Santhosh</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen relative" style={{ background: THEME.bgGradient }}>
      <input 
        type="file" 
        ref={fileInputRef} 
        className="hidden" 
        accept=".csv,.xlsx,.xls" 
        onChange={handleManualUpload} 
      />
      {quotaExhausted && (
        <div className="fixed top-0 left-0 right-0 h-1 bg-red-500 z-[100] animate-pulse"></div>
      )}
      {quotaExhausted && (
        <div className="fixed top-0 left-1/2 -translate-x-1/2 mt-2 px-6 py-2 bg-red-600/90 backdrop-blur-md border border-red-500/50 rounded-full text-white text-[10px] font-black uppercase tracking-[0.2em] shadow-2xl z-[100] flex items-center gap-4">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="animate-bounce" />
            Daily Quota Exhausted
          </div>
          <button 
            onClick={() => {
              setQuotaExhausted(false);
              enableNetwork(db).catch(console.error);
            }}
            className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg border border-white/20 transition-all text-[8px]"
          >
            Attempt Resume
          </button>
        </div>
      )}
      {/* Header */}
      <header className="mx-6 mt-6 p-4 flex items-center justify-between flex-wrap gap-4 bg-slate-800/70 backdrop-blur-xl border border-white/10 rounded-[16px] shadow-xl">
        <div className="flex items-center gap-3">
          <div className="relative w-10 h-10">
            <div className="absolute top-0 left-0 w-6 h-6 bg-axx-blue rounded-[6px] animate-[float_3s_ease-in-out_infinite]"></div>
            <div className="absolute bottom-0 right-0 w-5 h-5 bg-axx-light rounded-full animate-[float_3s_ease-in-out_1.5s_infinite]"></div>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-extrabold text-white tracking-tight">Axx<span className="text-axx-light">imum</span></span>
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">AI-Powered Project Analytics</span>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-axx-green/10 border border-axx-green/30 rounded-full text-axx-green text-[10px] font-bold">
             <div className="w-2 h-2 bg-axx-green rounded-full animate-pulse"></div>
             LIVE UPDATES
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-axx-blue/10 border border-axx-blue/30 rounded-full text-axx-light text-[10px] font-bold cursor-pointer hover:bg-axx-blue/20 transition-all">
             <div className={`w-2 h-2 bg-axx-light rounded-full ${syncing ? 'animate-spin border-t-transparent bg-transparent border-2' : ''}`}></div>
             {syncing ? 'SYNCING...' : 'AUTO-SYNC ON'}
          </div>

          <div className="hidden sm:flex flex-col items-end leading-tight">
            <span className="text-sm font-bold text-white">{user.displayName || user.email?.split('@')[0]}</span>
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">ADMIN</span>
          </div>

          <button 
            onClick={logout}
            className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg text-red-500 text-xs font-bold transition-all flex items-center gap-2"
          >
            <LogOut size={14} /> Logout
          </button>
        </div>
      </header>

      {/* Sync Countdown Bar */}
      <div className="mx-6 mt-1 overflow-hidden h-[3px] bg-axx-blue/20 rounded-full">
         <motion.div 
           className="h-full bg-axx-blue"
           style={{ width: `${countdown}%` }}
           transition={{ ease: 'linear', duration: 1 }}
         />
      </div>

      {/* Tabs bar */}
      <div className="mt-4 mx-6 flex items-center gap-1 border-b border-white/5 pb-0 bg-slate-900/50 rounded-t-[12px] overflow-x-auto no-scrollbar">
        <TabButton icon={<ChartLine size={16}/>} label="Overview" active={activeTab === '__overview__'} onClick={() => setActiveTab('__overview__')} />
        <TabButton icon={<UserCheck size={16}/>} label="Attendance" active={activeTab === '__attendance__'} onClick={() => setActiveTab('__attendance__')} />
        <TabButton icon={<History size={16}/>} label="Sync Manager" active={activeTab === '__syncmanager__'} onClick={() => setActiveTab('__syncmanager__')} />
        
        {projects.map(p => (
          <TabButton 
            key={p.id} 
            label={p.name} 
            active={activeTab === p.id} 
            onClick={() => setActiveTab(p.id)}
            dotColor="#60a5fa"
            count={p.data?.length}
            syncStatus={projectSyncStatus[p.id]}
            onClose={(e) => {
              e.stopPropagation();
              if (quotaExhausted) return;
              if(confirm('Delete project?')) deleteDoc(doc(db, 'projects', p.id));
            }}
          />
        ))}

        <button 
          onClick={() => setShowNewProjectModal(true)}
          className="p-3 text-slate-500 hover:text-white transition-all flex-shrink-0"
        >
          <Plus size={20} />
        </button>
      </div>

      <main className="p-6 pb-24 overflow-y-auto h-[calc(100vh-220px)] no-scrollbar">
        {activeTab === '__overview__' && <Overview projects={projects} syncStatuses={projectSyncStatus} onOpenProject={(id) => setActiveTab(id)} />}
        {activeTab === '__attendance__' && <AttendanceView user={user} />}
        {activeTab === '__syncmanager__' && (
          <SyncManager 
            projects={projects} 
            syncLog={syncLog} 
            syncStatuses={projectSyncStatus}
            setSyncIntervalMs={setSyncIntervalMs} 
            syncIntervalMs={syncIntervalMs}
            onSyncAll={() => {
              if (quotaExhausted) return;
              projects.forEach(p => syncProject(p));
            }}
            onClearLog={() => setSyncLog([])}
            onManualUpload={(id: string) => {
              setTargetProjectId(id);
              fileInputRef.current?.click();
            }}
            onUnlink={async (id: string) => {
              if (quotaExhausted) return;
              try {
                await updateDoc(doc(db, 'projects', id), { sheetUrl: "" });
                addLog('System', 'warn', 'Data source unlinked from project');
              } catch (err: any) {
                handleFirestoreError(err, OperationType.UPDATE, `projects/${id}`);
              }
            }}
            onLinkURL={async (id, url) => {
              if (quotaExhausted) return;
              const p = projects.find(x => x.id === id);
              if (p) {
                try {
                  await updateDoc(doc(db, 'projects', id), { sheetUrl: url });
                } catch (err: any) {
                  handleFirestoreError(err, OperationType.UPDATE, `projects/${id}`);
                }
              }
            }}
          />
        )}
        {projects.find(p => p.id === activeTab) && (
          <ProjectView 
            project={projects.find(p => p.id === activeTab)!} 
            syncStatus={projectSyncStatus[activeTab]}
            onSync={() => syncProject(projects.find(p => p.id === activeTab)!)}
            onManualUpload={(id) => {
              setTargetProjectId(id);
              fileInputRef.current?.click();
            }}
          />
        )}
      </main>

      <AnimatePresence>
        {showNewProjectModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
            <motion.div 
               initial={{ opacity: 0, scale: 0.9 }}
               animate={{ opacity: 1, scale: 1 }}
               exit={{ opacity: 0, scale: 0.9 }}
               className="bg-slate-800 border border-white/10 rounded-[20px] p-8 w-full max-w-md shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold text-white">Initialize New Source</h3>
                <button onClick={() => setShowNewProjectModal(false)}><X size={20}/></button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs uppercase tracking-widest text-slate-500 mb-2 font-bold">Source Name</label>
                  <input 
                    className="w-full bg-black/20 border border-white/10 rounded-[10px] p-4 text-white text-sm"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    placeholder="e.g. PROJECT_OMEGA"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-widest text-slate-500 mb-2 font-bold">Sheets URL (Optional)</label>
                  <input 
                    className="w-full bg-black/20 border border-white/10 rounded-[10px] p-4 text-white text-sm"
                    value={newProjectUrl}
                    onChange={e => setNewProjectUrl(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/..."
                  />
                </div>
                <button 
                  onClick={addNewSource}
                  className="w-full py-4 bg-axx-blue text-white font-bold rounded-[10px] hover:bg-axx-light transition-all"
                >
                  Register Source
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TabButton({ icon, label, active, onClick, dotColor, count, onClose, syncStatus }: any) {
  return (
    <div 
      onClick={onClick}
      className={`px-5 py-4 flex items-center gap-2 cursor-pointer border-b-2 transition-all group whitespace-nowrap ${active ? 'text-axx-light border-axx-blue' : 'text-slate-400 border-transparent hover:text-white'}`}
    >
      {syncStatus === 'syncing' ? (
        <RefreshCcw size={14} className="animate-spin text-axx-light" />
      ) : dotColor ? (
        <div className="w-2 h-2 rounded-full" style={{ background: dotColor }}></div>
      ) : null}
      {icon}
      <span className="text-sm font-semibold">{label}</span>
      {count !== undefined && <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-slate-500 font-bold">{count}</span>}
      {syncStatus === 'error' && (
        <AlertCircle size={12} className="text-red-500 ml-1" />
      ) || syncStatus === 'success' && (
        <CheckCircle size={12} className="text-axx-green ml-1" />
      )}
      {onClose && (
        <X size={14} className="opacity-0 group-hover:opacity-60 hover:!opacity-100 ml-1" onClick={onClose} />
      )}
    </div>
  );
}

function MetricCard({ title, value, subtitle, icon, progress, color = 'blue' }: any) {
  const colorMap: any = { blue: 'text-axx-blue', green: 'text-axx-green', purple: 'text-axx-purple', orange: 'text-axx-orange' };
  const borderMap: any = { blue: 'border-axx-blue/20', green: 'border-axx-green/20', purple: 'border-axx-purple/20', orange: 'border-axx-orange/20' };

  return (
    <div className={`p-6 bg-slate-800/40 border ${borderMap[color]} rounded-[16px] backdrop-blur-md shadow-lg shadow-black/20 hover:scale-[1.02] transition-all`}>
      <div className="flex items-center justify-between mb-4">
        <div className={`p-3 rounded-xl bg-white/5 ${colorMap[color]}`}>{icon}</div>
        <div className={`px-2 py-1 rounded text-[10px] font-bold ${colorMap[color]} bg-white/5`}>LIVE</div>
      </div>
      <div className="text-3xl font-extrabold text-white mb-1 tracking-tighter">{value}</div>
      <div className="text-xs text-slate-500 uppercase tracking-widest font-semibold">{title}</div>
      {progress !== undefined && (
        <div className="mt-4 h-1.5 w-full bg-black/40 rounded-full overflow-hidden">
          <motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} className={`h-full bg-${color}-500`} style={{ background: THEME[color as keyof typeof THEME] }} />
        </div>
      )}
    </div>
  );
}

function Overview({ projects, onOpenProject, syncStatuses }: { projects: Project[], onOpenProject: (id: string) => void, syncStatuses?: Record<string, string> }) {
  const totalTasks = projects.reduce((sum, p) => sum + (p.data?.length || 0), 0);
  const totalCompleted = projects.reduce((sum, p) => sum + (p.data?.filter((x: any) => /done/i.test(x.status)).length || 0) , 0);
  const completionRate = totalTasks > 0 ? (totalCompleted / totalTasks) * 100 : 0;

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <MetricCard title="Total Projects" value={projects.length} icon={<Database size={24}/>} color="blue" />
        <MetricCard title="Total Tasks" value={totalTasks} icon={<Rocket size={24}/>} color="green" progress={completionRate} />
        <MetricCard title="Team Members" value={3} icon={<User size={24}/>} color="purple" />
        <MetricCard title="Pages Completed" value="161 / 161" icon={<FileText size={24}/>} color="orange" progress={100} />
      </div>

      <div className="bg-slate-800/40 border border-white/5 rounded-[20px] p-8 shadow-2xl">
        <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-3">
          <ChartLine size={20} className="text-axx-blue" /> Project Summary <span className="text-slate-500 font-normal text-xs uppercase tracking-widest">(Click to open project)</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map(p => {
             const stats = (p.data || []).reduce((acc: any, row: any) => {
               const status = (row.Status || row.STATUS || row.status || '').toLowerCase();
               const isDone = /compl|done|finish/i.test(status);
               const isInProgress = /prog|work|open/i.test(status) || (!isDone && status !== '');
               
               const rawPages = row.Pages || row.PAGES || row.NO_OF_PAGE || row.No_Of_Page || row.pages || row.No_of_page || '0';
               const pages = parseFloat(String(rawPages).replace(/[^0-9.]/g, '')) || 0;

               if (isDone) {
                 acc.done++;
                 acc.pagesDone += pages;
               } else if (isInProgress) {
                 acc.progress++;
               } else {
                 acc.pending++;
               }
               return acc;
             }, { done: 0, progress: 0, pending: 0, pagesDone: 0 });

             const total = p.data?.length || 0;
             const completionRate = total > 0 ? (stats.done / total * 100) : 0;
             const status = syncStatuses?.[p.id];
             return (
               <div 
                 key={p.id} 
                 onClick={() => onOpenProject(p.id)}
                 className={`p-6 bg-black/20 border rounded-[16px] transition-all cursor-pointer group relative overflow-hidden ${status === 'syncing' ? 'border-axx-blue shadow-[0_0_15px_rgba(0,120,212,0.3)]' : 'border-white/5 hover:border-axx-blue/50'}`}
                >
                 {status === 'syncing' && (
                    <motion.div 
                      className="absolute inset-0 bg-axx-blue/5 pointer-events-none"
                      animate={{ opacity: [0.2, 0.5, 0.2] }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                    />
                 )}
                 <div className="flex items-center gap-3 mb-4 relative z-10">
                   <div className={`w-2 h-2 rounded-full ${status === 'error' ? 'bg-red-500' : 'bg-axx-blue'} group-hover:animate-pulse`}></div>
                   <span className="font-bold text-slate-200 truncate flex-1">{p.name}</span>
                   <span className={`text-[10px] font-bold flex items-center gap-1 ${status === 'error' ? 'text-red-500' : 'text-axx-green'}`}>
                     <RefreshCcw size={10} className={status === 'syncing' ? 'animate-spin' : ''} /> 
                     {status === 'syncing' ? 'SYNCING...' : status === 'error' ? 'ERR' : 'LIVE'}
                   </span>
                 </div>
                 <div className="flex justify-between mb-4 relative z-10">
                    <div className="text-center"><div className="text-[10px] text-slate-500 uppercase">Done</div><div className="text-axx-green font-bold">{stats.done}</div></div>
                    <div className="text-center"><div className="text-[10px] text-slate-500 uppercase">Progress</div><div className="text-axx-orange font-bold">{stats.progress}</div></div>
                    <div className="text-center"><div className="text-[10px] text-slate-500 uppercase">Pending</div><div className="text-axx-purple font-bold">{stats.pending}</div></div>
                 </div>
                 <div className="text-[10px] text-slate-500 mb-1 relative z-10">Task Completion: {completionRate.toFixed(0)}%</div>
                 <div className="h-1 w-full bg-black/40 rounded-full overflow-hidden mb-2 relative z-10">
                    <div className="h-full bg-axx-blue" style={{ width: `${completionRate}%` }}></div>
                 </div>
                 <div className="text-[10px] text-slate-600 italic relative z-10">Pages: {stats.pagesDone.toFixed(0)} done</div>
               </div>
             )
          })}
        </div>
      </div>
    </div>
  );
}

function SyncManager({ projects, syncLog, setSyncIntervalMs, syncIntervalMs, onSyncAll, onLinkURL, onUnlink, syncStatuses, onClearLog, onManualUpload }: any) {
  const [selectedId, setSelectedId] = useState('');
  const [url, setUrl] = useState('');

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
       <div className="bg-slate-800/40 border border-white/10 rounded-[20px] p-8">
          <div className="flex items-center justify-between mb-8">
             <h2 className="text-2xl font-bold text-white flex items-center gap-3"><RefreshCcw size={24} className="text-axx-light" /> Google Sheets Sync Manager</h2>
             <button onClick={onSyncAll} className="px-6 py-3 bg-axx-blue/20 hover:bg-axx-blue/30 border border-axx-blue/30 rounded-xl text-axx-light text-sm font-bold flex items-center gap-2 transition-all">
               <RefreshCcw size={18} /> Sync All Now
             </button>
          </div>

          <div className="p-6 bg-axx-blue/5 border border-axx-blue/20 rounded-[16px] mb-8">
             <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                   <div className="font-bold text-axx-light flex items-center gap-2 mb-1"><Clock size={16}/> Auto-Sync Settings</div>
                   <div className="text-xs text-slate-500">Sheets are automatically synced periodically to maintain data accuracy.</div>
                </div>
                <div className="flex items-center gap-4">
                   <span className="text-xs text-slate-400 font-bold uppercase tracking-widest">Interval:</span>
                   <select 
                     value={syncIntervalMs} 
                     onChange={e => setSyncIntervalMs(Number(e.target.value))}
                     className="bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white"
                    >
                      <option value={300000}>5 minutes (Standard)</option>
                      <option value={600000}>10 minutes</option>
                      <option value={1800000}>30 minutes</option>
                      <option value={3600000}>1 hour</option>
                   </select>
                </div>
             </div>
          </div>

          <div className="p-6 bg-slate-900/50 border border-white/5 rounded-[16px] mb-8">
             <div className="font-bold text-axx-light mb-4">Link New Sheet URL</div>
             <div className="flex gap-4">
                <select 
                  className="bg-slate-800 border border-white/10 rounded-lg p-3 text-sm text-white flex-1"
                  value={selectedId}
                  onChange={e => setSelectedId(e.target.value)}
                >
                  <option value="">Select project...</option>
                  {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input 
                  className="bg-slate-800 border border-white/10 rounded-lg p-3 text-sm text-white flex-[2]" 
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                />
                <button 
                  onClick={() => { onLinkURL(selectedId, url); setSelectedId(''); setUrl(''); }}
                  className="px-6 py-3 bg-axx-blue text-white rounded-lg font-bold flex items-center gap-2 hover:bg-axx-light transition-all"
                >
                  <LinkIcon size={18} /> Link URL
                </button>
             </div>
          </div>

          <div className="space-y-4">
             <div className="font-bold text-white">Linked Projects</div>
             {projects.filter((p: any) => p.sheetUrl).map((p: any) => {
               const status = syncStatuses?.[p.id];
               return (
               <div key={p.id} className="p-4 bg-black/20 border border-white/5 rounded-xl flex items-center justify-between group">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${status === 'syncing' ? 'bg-axx-light animate-pulse shadow-[0_0_8px_#60a5fa]' : status === 'error' ? 'bg-red-500' : 'bg-axx-blue'}`}></div>
                    <div>
                      <div className="font-bold text-slate-200 flex items-center gap-2">
                        {p.name}
                        {status === 'syncing' && <RefreshCcw size={10} className="animate-spin text-axx-light" />}
                        {status === 'error' && <AlertCircle size={10} className="text-red-500" />}
                        {status === 'success' && <CheckCircle size={10} className="text-axx-green" />}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate max-w-sm">{p.sheetUrl}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                       <span className="text-[10px] text-slate-500 uppercase font-bold">Target Pages:</span>
                       <input className="bg-slate-800 border border-white/10 rounded p-1 w-16 text-center text-xs text-white" defaultValue="0" />
                    </div>
                    <button 
                      onClick={() => onManualUpload(p.id)}
                      className="p-2 bg-axx-blue/10 text-axx-light rounded border border-axx-blue/20 opacity-40 group-hover:opacity-100 transition-all hover:bg-axx-blue/20" 
                      title="Upload CSV/Excel"
                    >
                      <FileSpreadsheet size={14}/>
                    </button>
                    <button 
                      onClick={() => onUnlink(p.id)}
                      className="p-2 bg-red-500/10 text-red-500 rounded border border-red-500/20 opacity-40 group-hover:opacity-100 transition-all hover:bg-red-500/20" 
                      title="Unlink"
                    >
                      <Unlink size={14}/>
                    </button>
                  </div>
               </div>
             )})}
          </div>

          <div className="mt-12 bg-black/30 border border-white/5 rounded-[24px] overflow-hidden">
             <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-white/2">
                <div className="font-bold text-white flex items-center gap-2 uppercase tracking-widest text-xs">
                  <History size={16} className="text-axx-blue"/> 
                  Master Sync Registry
                </div>
                <div className="flex items-center gap-4">
                   <div className="text-[10px] text-slate-500 font-bold">{syncLog.length} ACTIVITIES</div>
                   <button 
                    onClick={onClearLog}
                    className="text-[10px] text-red-500 hover:text-red-400 font-bold uppercase tracking-widest px-3 py-1 bg-red-500/10 rounded transition-all"
                   >
                    Purge History
                   </button>
                </div>
             </div>
             
             <div className="max-h-[400px] overflow-y-auto no-scrollbar">
                {syncLog.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-600">
                    <History size={48} className="opacity-20 mb-4" />
                    <p className="text-sm font-medium">No sync activities recorded yet.</p>
                  </div>
                ) : (
                  <table className="w-full text-left font-mono text-[11px] border-collapse">
                    <thead className="sticky top-0 bg-slate-900 text-slate-500 z-10">
                      <tr>
                        <th className="py-3 px-6 font-bold uppercase tracking-widest text-[10px]">Timestamp</th>
                        <th className="py-3 px-6 font-bold uppercase tracking-widest text-[10px]">Source</th>
                        <th className="py-3 px-6 font-bold uppercase tracking-widest text-[10px]">Status</th>
                        <th className="py-3 px-6 font-bold uppercase tracking-widest text-[10px]">Diagnostic Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {syncLog.map((log: any, i: number) => (
                        <tr key={i} className="hover:bg-axx-blue/5 transition-colors group">
                          <td className="py-4 px-6 text-slate-400 whitespace-nowrap">{log.time}</td>
                          <td className="py-4 px-6 text-white font-bold">{log.name}</td>
                          <td className="py-4 px-6">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                              log.type === 'success' ? 'bg-axx-green/10 text-axx-green border border-axx-green/20' : 
                              log.type === 'error' ? 'bg-red-500/10 text-red-500 border border-red-500/20' : 
                              'bg-axx-orange/10 text-axx-orange border border-axx-orange/20'
                            }`}>
                              {log.type === 'success' && <CheckCircle size={10} />}
                              {log.type === 'error' && <XCircle size={10} />}
                              {log.type === 'warn' && <AlertTriangle size={10} />}
                              {log.type}
                            </span>
                          </td>
                          <td className={`py-4 px-6 ${
                            log.type === 'error' ? 'text-red-400' : 
                            log.type === 'success' ? 'text-slate-300' : 
                            'text-axx-orange'
                          }`}>
                            {log.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
             </div>
          </div>
       </div>
    </div>
  );
}

function ProjectView({ project, onSync, syncStatus, onManualUpload }: { project: Project, onSync: () => void, syncStatus?: string, onManualUpload: (pId: string) => void }) {
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const results = React.useMemo(() => {
    if (!project.data) return { userAggr: [], summary: { totalTargetPages: 0, completedPages: 0, inProgressCount: 0, pendingPages: 0 } };
    
    const aggregation: Record<string, { 
      name: string, 
      totalEntries: number, 
      completedEntries: number, 
      inProgressEntries: number,
      completedPages: number,
      uniqueLinks: Set<string>,
      completedUniqueLinks: Set<string>
    }> = {};

    let totalTargetPages = 0;
    let completedPages = 0;
    let inProgressCount = 0;

    project.data.forEach((row: any) => {
      const userName = row['USER NAME'] || row.NAME || row.Name || row.name || row.user || 'Unknown';
      const link = row.LINK || row.Link || row.link || '';
      const status = (row.Status || row.STATUS || row.status || '').toLowerCase();
      const rawPages = row.Pages || row.PAGES || row.NO_OF_PAGE || row.No_Of_Page || row.pages || row.No_of_page || '0';
      const pages = parseFloat(String(rawPages).replace(/[^0-9.]/g, '')) || 0;
      
      totalTargetPages += pages;

      if (!aggregation[userName]) {
        aggregation[userName] = {
          name: userName,
          totalEntries: 0,
          completedEntries: 0,
          inProgressEntries: 0,
          completedPages: 0,
          uniqueLinks: new Set(),
          completedUniqueLinks: new Set()
        };
      }

      const user = aggregation[userName];
      user.totalEntries++;
      if (link) user.uniqueLinks.add(link);

      const isCompleted = /compl|done|finish/i.test(status);
      const isInProgress = /prog|work|open/i.test(status) || (!isCompleted && status !== '');

      if (isCompleted) {
        completedPages += pages;
        if (link) {
          if (!user.completedUniqueLinks.has(link)) {
            user.completedUniqueLinks.add(link);
            user.completedEntries++;
            user.completedPages += pages;
          }
        } else {
          user.completedEntries++;
          user.completedPages += pages;
        }
      } else if (isInProgress) {
        inProgressCount++;
        user.inProgressEntries++;
      }
    });

    return {
      userAggr: Object.values(aggregation).sort((a, b) => b.completedPages - a.completedPages),
      summary: {
        totalTargetPages,
        completedPages,
        inProgressCount,
        pendingPages: Math.max(0, totalTargetPages - completedPages),
        userCount: Object.keys(aggregation).length
      }
    };
  }, [project.data]);

  const { userAggr, summary } = results as { userAggr: any[], summary: any };

  const runAiAnalysis = async () => {
    setAnalyzing(true);
    try {
      const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
      const stats = userAggr.map(u => ({
        user: u.name,
        completedUnique: u.completedEntries,
        inProgress: u.inProgressEntries,
        completedPages: u.completedPages
      }));

      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze this user performance and activity data for the project "${project.name}": ${JSON.stringify(stats)}. 
        
        Please provide a detailed report including:
        1. **Executive Summary**: A high-level overview of project health.
        2. **Top Performer**: Who is the most productive based on completed unique links and volume of pages? Explain why.
        3. **Potential Bottlenecks**: Are there specific users with high assigned items but low completion? Or low efficiency?
        4. **Actionable Recommendations**: 3-5 specific, professional recommendations to improve the current workflow and velocity.
        
        Format the response in clean Markdown.`,
      });

      setAiAnalysis(response.text || 'No analysis available.');
    } catch (err) {
      console.error(err);
      setAiAnalysis('Failed to generate AI analysis. Please check your API key.');
    } finally {
      setAnalyzing(false);
    }
  };

  if (!project.data || project.data.length === 0) return (
    <div className="max-w-4xl mx-auto py-24 text-center">
       <div className="bg-slate-800/40 border border-white/10 p-12 rounded-[32px] inline-block mb-8">
          <CloudUpload size={64} className="text-axx-blue/30 mx-auto mb-4" />
          <h3 className="text-2xl font-bold text-white mb-2">No Data Sources</h3>
          <p className="text-slate-400 text-sm max-w-xs mx-auto mb-8">Ready to track user activities. Link a Google Sheet URL or upload a file to begin.</p>
          <div className="flex flex-col sm:flex-row items-center gap-4 justify-center">
            <button 
              onClick={onSync}
              disabled={syncStatus === 'syncing' || !project.sheetUrl}
              className="px-8 py-4 bg-axx-blue text-white rounded-xl font-bold flex items-center gap-3 hover:bg-axx-light transition-all disabled:opacity-50"
            >
              <RefreshCcw size={20} className={syncStatus === 'syncing' ? 'animate-spin' : ''} /> 
              {syncStatus === 'syncing' ? 'Syncing...' : project.sheetUrl ? 'Force Sync' : 'Link Sheet First'}
            </button>
            <button 
              onClick={() => onManualUpload(project.id)}
              className="px-8 py-4 bg-white/5 border border-white/10 text-white rounded-xl font-bold flex items-center gap-3 hover:bg-white/10 transition-all"
            >
              <FileSpreadsheet size={20} /> Upload CSV/Excel
            </button>
          </div>
       </div>
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto space-y-8">
       <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-extrabold text-white flex items-center gap-4">
             <div className={`w-4 h-4 rounded-full ${syncStatus === 'syncing' ? 'bg-axx-light animate-pulse shadow-[0_0_15px_#60a5fa]' : 'bg-axx-blue'}`}></div>
             {project.name}
          </h1>
          <div className="flex items-center gap-4">
             <div className="text-right">
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Status</div>
                <div className={`text-sm font-mono ${syncStatus === 'error' ? 'text-red-500' : syncStatus === 'syncing' ? 'text-axx-light' : 'text-axx-green'}`}>
                  {syncStatus?.toUpperCase() || 'LIVE'}
                </div>
             </div>
             <div className="text-right border-l border-white/10 pl-4">
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Last Synced</div>
                <div className="text-sm font-mono text-slate-300">{project.lastSynced ? new Date(project.lastSynced).toLocaleTimeString() : 'Never'}</div>
             </div>
             <button 
              onClick={onSync} 
              disabled={syncStatus === 'syncing'}
              className="p-4 bg-axx-blue/20 text-axx-light border border-axx-blue/30 rounded-full hover:bg-axx-blue/30 transition-all disabled:opacity-50"
             >
                <RefreshCcw size={20} className={syncStatus === 'syncing' ? 'animate-spin' : ''} />
             </button>
          </div>
       </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
           <div className="bg-slate-800/40 border border-white/5 p-6 rounded-[20px] text-center backdrop-blur-sm">
              <div className="text-axx-blue flex justify-center mb-2"><User size={20}/></div>
              <div className="text-2xl font-black text-white">{summary.userCount}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Total Users</div>
           </div>
           <div className="bg-slate-800/40 border border-white/5 p-6 rounded-[20px] text-center backdrop-blur-sm">
              <div className="text-axx-purple flex justify-center mb-2"><FileText size={20}/></div>
              <div className="text-2xl font-black text-white">{summary.totalTargetPages.toFixed(0)}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Total Target Pages</div>
           </div>
           <div className="bg-slate-800/40 border border-white/5 p-6 rounded-[20px] text-center backdrop-blur-sm">
              <div className="text-axx-green flex justify-center mb-2"><CheckCircle2 size={20}/></div>
              <div className="text-2xl font-black text-white">{summary.completedPages.toFixed(0)}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Completed Pages</div>
           </div>
           <div className="bg-slate-800/40 border border-white/5 p-6 rounded-[20px] text-center backdrop-blur-sm">
              <div className="text-axx-orange flex justify-center mb-2"><Clock size={20}/></div>
              <div className="text-2xl font-black text-white">{summary.inProgressCount}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">In-Progress Count</div>
           </div>
           <div className="bg-slate-800/40 border border-white/5 p-6 rounded-[20px] text-center backdrop-blur-sm">
              <div className="text-axx-blue flex justify-center mb-2"><AlertCircle size={20}/></div>
              <div className="text-2xl font-black text-white">{summary.pendingPages.toFixed(0)}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Pending Pages</div>
           </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 bg-slate-800/40 border border-white/5 p-8 rounded-[24px]">
             <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold text-white flex items-center gap-2"><UserCheck size={20} className="text-axx-green"/> User Productivity Breakdown</h3>
                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{userAggr.length} USERS DETECTED</div>
             </div>
             <div className="overflow-x-auto no-scrollbar">
                <table className="w-full text-left font-mono text-xs">
                   <thead>
                      <tr className="border-b border-white/10 text-slate-500 uppercase">
                         <th className="pb-4 px-4">User Name</th>
                         <th className="pb-4 px-4 text-center">Completed (Uniq)</th>
                         <th className="pb-4 px-4 text-center">In-Progress</th>
                         <th className="pb-4 px-4 text-center">Total Pages</th>
                         <th className="pb-4 px-4 text-right">Efficiency</th>
                      </tr>
                   </thead>
                   <tbody className="text-slate-300">
                      {userAggr.map((u, i) => (
                        <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-all group">
                           <td className="py-4 px-4 font-bold text-slate-200 flex items-center gap-2">
                             <div className="w-6 h-6 rounded-full bg-axx-blue/20 flex items-center justify-center text-[10px] text-axx-light group-hover:bg-axx-blue/40 transition-all">{u.name[0]}</div>
                             {u.name}
                           </td>
                           <td className="py-4 px-4 text-center text-axx-green font-bold">{u.completedEntries}</td>
                           <td className="py-4 px-4 text-center text-axx-orange">{u.inProgressEntries}</td>
                           <td className="py-4 px-4 text-center">
                             <span className="px-2 py-1 bg-axx-purple/10 text-axx-purple rounded border border-axx-purple/20">
                               {u.completedPages.toFixed(1)}
                             </span>
                           </td>
                           <td className="py-4 px-4 text-right">
                             {u.totalEntries > 0 ? ((u.completedEntries / u.totalEntries) * 100).toFixed(0) : 0}%
                           </td>
                        </tr>
                      ))}
                   </tbody>
                </table>
             </div>
          </div>

          <div className="bg-slate-800/40 border border-white/5 p-8 rounded-[24px] flex flex-col">
             <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold text-white flex items-center gap-2"><Brain size={20} className="text-axx-light"/> AI Analytics</h3>
                <button 
                  onClick={runAiAnalysis}
                  disabled={analyzing}
                  className="p-2 bg-axx-light/10 text-axx-light rounded-lg hover:bg-axx-light/20 transition-all disabled:opacity-50"
                >
                  <RefreshCcw size={14} className={analyzing ? 'animate-spin' : ''} />
                </button>
             </div>
             
             <div className="flex-1 overflow-y-auto no-scrollbar space-y-4">
                {analyzing ? (
                  <div className="space-y-3">
                    <div className="h-4 bg-slate-700/50 rounded animate-pulse w-3/4"></div>
                    <div className="h-4 bg-slate-700/50 rounded animate-pulse"></div>
                    <div className="h-4 bg-slate-700/50 rounded animate-pulse w-5/6"></div>
                  </div>
                ) : aiAnalysis ? (
                  <div className="prose prose-invert prose-xs text-slate-300 leading-relaxed text-[11px] font-mono whitespace-pre-wrap max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                    <Markdown>{aiAnalysis}</Markdown>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center text-slate-500">
                    <Brain size={48} className="opacity-10 mb-4" />
                    <p className="text-[10px] uppercase tracking-widest font-bold">Ready for Deep Analysis</p>
                    <button 
                      onClick={runAiAnalysis}
                      className="mt-4 px-4 py-2 border border-axx-light/30 text-axx-light rounded-lg text-[10px] font-bold uppercase transition-all hover:bg-axx-light/10"
                    >
                      Process Insight
                    </button>
                  </div>
                )}
             </div>
          </div>
       </div>

       <div className="grid grid-cols-1 gap-8">
          <div className="p-8 bg-slate-800/40 border border-white/5 rounded-[24px]">
             <div className="flex items-center justify-between mb-4">
               <h3 className="text-xl font-bold text-white flex items-center gap-2"><Trophy size={20} className="text-axx-light"/> Project-Specific Daily Target</h3>
               <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest leading-none">
                 {new Date().toISOString().split('T')[0]}
               </div>
             </div>
             <div className="flex items-center gap-6">
               <div className="flex-1">
                  <div className="h-4 bg-slate-900 rounded-full overflow-hidden border border-white/5">
                     <motion.div 
                       initial={{ width: 0 }}
                       animate={{ width: `${Math.min((userAggr.reduce((acc: number, u: any) => acc + u.completedEntries, 0) / 100) * 100, 100)}%` }}
                       className="h-full bg-gradient-to-r from-axx-blue to-axx-light"
                     />
                  </div>
                  <div className="flex justify-between mt-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                     <span>Progress: {userAggr.reduce((acc: number, u: any) => acc + u.completedEntries, 0)} Resolved</span>
                     <span>Goal: 100</span>
                  </div>
               </div>
               <div className="text-center">
                  <div className="text-3xl font-black text-white">{Math.min((userAggr.reduce((acc: number, u: any) => acc + u.completedEntries, 0) / 100) * 100, 100).toFixed(0)}%</div>
                  <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Efficiency</div>
               </div>
             </div>
          </div>
       </div>
    </div>
  );
}

// High fidelity subviews
function PagesAnalytics({ projects }: { projects: Project[] }) { 
  const totalPagesAssigned = projects.reduce((s, p) => s + (p.data?.length || 0), 0);
  const totalPagesCompleted = projects.reduce((s, p) => s + (p.data?.filter((x: any) => /done|finish/i.test(x.status)).length || 0), 0);
  const totalTarget = 1000; // Placeholder
  const completionRate = totalPagesAssigned > 0 ? (totalPagesCompleted / totalPagesAssigned * 100) : 0;

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="bg-slate-800/40 border border-white/10 rounded-[20px] p-8 shadow-2xl">
         <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3"><FileText size={24} className="text-axx-purple" /> Total Pages Analytics</h2>
            <div className="flex gap-2">
               <button className="px-4 py-2 bg-axx-purple/10 border border-axx-purple/20 rounded-lg text-axx-purple text-[10px] font-bold uppercase tracking-widest hover:bg-axx-purple/20">CSV</button>
               <button className="px-4 py-2 bg-axx-purple/10 border border-axx-purple/20 rounded-lg text-axx-purple text-[10px] font-bold uppercase tracking-widest hover:bg-axx-purple/20">JSON</button>
               <button className="px-4 py-2 bg-axx-purple/10 border border-axx-purple/20 rounded-lg text-axx-purple text-[10px] font-bold uppercase tracking-widest hover:bg-axx-purple/20">PDF</button>
            </div>
         </div>

         <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 mb-8">
            <MiniStat icon={<FileText size={16}/>} label="Assigned" value={totalPagesAssigned} color="purple" />
            <MiniStat icon={<AlertCircle size={16}/>} label="Target" value={totalTarget} color="blue" />
            <MiniStat icon={<CheckCircle2 size={16}/>} label="Completed" value={totalPagesCompleted} color="green" />
            <MiniStat icon={<Clock size={16}/>} label="Pending" value={totalPagesAssigned - totalPagesCompleted} color="orange" />
            <MiniStat icon={<Database size={16}/>} label="Rate" value={`${completionRate.toFixed(1)}%`} color="blue" />
            <MiniStat icon={<User size={16}/>} label="Avg/User" value="53.7" color="cyan" />
            <MiniStat icon={<Zap size={16}/>} label="Velocity" value="12.4" color="yellow" />
            <MiniStat icon={<Trophy size={16}/>} label="Achievement" value="94.2%" color="pink" />
         </div>

         <div className="bg-black/20 border border-white/5 rounded-[20px] p-8 h-[300px] mb-8">
            <ResponsiveContainer width="100%" height="100%">
               <BarChart data={projects.slice(0, 5)}>
                  <XAxis dataKey="name" stroke="#475569" fontSize={10}/>
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #ffffff10' }} />
                  <Bar dataKey={(p) => p.data?.length || 0} fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey={(p) => p.data?.filter((x: any) => /done/i.test(x.status)).length || 0} fill="#10b981" radius={[4, 4, 0, 0]} />
               </BarChart>
            </ResponsiveContainer>
         </div>
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value, color }: any) {
  const colors: any = { 
    purple: 'text-axx-purple', blue: 'text-axx-blue', green: 'text-axx-green', 
    orange: 'text-axx-orange', cyan: 'text-cyan-400', yellow: 'text-yellow-400', 
    pink: 'text-pink-400' 
  };
  return (
    <div className="p-4 bg-white/5 border border-white/5 rounded-xl text-center">
       <div className={`${colors[color]} flex justify-center mb-2`}>{icon}</div>
       <div className="text-xl font-black text-white">{value}</div>
       <div className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">{label}</div>
    </div>
  );
}

function AttendanceView({ user }: any) { 
  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <div className="bg-slate-800/40 border border-white/10 p-8 rounded-[24px]">
        <div className="flex items-center justify-between mb-8">
           <h2 className="text-2xl font-bold text-white flex items-center gap-3"><UserCheck size={24} className="text-axx-green" /> Attendance Management</h2>
           <button className="px-6 py-3 bg-axx-green/10 border border-axx-green/30 rounded-xl text-axx-green text-sm font-bold flex items-center gap-2 transition-all">
             <CloudUpload size={18} /> Upload Attendance CSV
           </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-6 mb-8">
           <MiniStat icon={<User size={16}/>} label="Total Staff" value="3" color="blue" />
           <MiniStat icon={<CheckCircle size={16}/>} label="Present" value="3" color="green" />
           <MiniStat icon={<X size={16}/>} label="Absent" value="0" color="red" />
           <MiniStat icon={<Clock size={16}/>} label="Half Day" value="0" color="yellow" />
        </div>

        <div className="bg-black/20 border border-white/5 rounded-xl overflow-hidden">
           <table className="w-full text-left text-xs font-mono">
              <thead className="bg-white/5 text-slate-500 uppercase">
                 <tr><th className="p-4">Name</th><th className="p-4">Status</th><th className="p-4">Date</th></tr>
              </thead>
              <tbody className="text-slate-300">
                 <tr className="border-t border-white/5"><td className="p-4">Santhosh</td><td className="p-4 text-axx-green font-bold">PRESENT</td><td className="p-4 opacity-50">2026-04-17</td></tr>
                 <tr className="border-t border-white/5"><td className="p-4">Demo User</td><td className="p-4 text-axx-green font-bold">PRESENT</td><td className="p-4 opacity-50">2026-04-17</td></tr>
              </tbody>
           </table>
        </div>
      </div>
    </div>
  ); 
}

function TodayTarget({ projects }: { projects: Project[] }) { 
  const today = new Date().toISOString().split('T')[0];
  const todayData = projects.flatMap(p => 
    p.data?.filter((row: any) => {
      // Find any column that looks like a date
      const dateKey = Object.keys(row).find(k => k.toLowerCase().includes('date'));
      if (!dateKey) return false;
      const rowDate = String(row[dateKey]);
      return rowDate.includes(today);
    }) || []
  );
  const resolved = todayData.length;
  const target = 100;
  const progress = Math.min(resolved / target * 100, 100);

  return (
    <div className="max-w-7xl mx-auto space-y-8">
       <div className="p-12 bg-axx-blue/10 border border-axx-blue/20 rounded-[32px] text-center backdrop-blur-md">
          <Trophy size={64} className="text-axx-light mx-auto mb-4" />
          <h2 className="text-4xl font-black text-white mb-2 tracking-tighter">DAILY PRECISION REGISTRY</h2>
          <p className="text-slate-400 uppercase tracking-widest font-bold">TRACKING CYCLE: {today}</p>
          
          <div className="mt-12 max-w-2xl mx-auto space-y-8">
             <div className="space-y-3">
               <div className="flex justify-between text-xs font-bold text-slate-500 uppercase tracking-widest">
                 <span>Cycle Completion (Vector Tracking)</span>
                 <span className={progress >= 100 ? "text-axx-green" : "text-axx-light"}>{progress.toFixed(1)}% Optimized</span>
               </div>
               <div className="h-4 bg-black/40 rounded-full overflow-hidden border border-white/5">
                  <motion.div initial={{width:0}} animate={{width:`${progress}%`}} className="h-full bg-gradient-to-r from-axx-blue to-axx-light shadow-[0_0_20px_rgba(0,120,212,0.5)]" />
               </div>
               <div className="flex justify-between text-[10px] text-slate-500 font-bold">
                 <span>Status: {progress >= 100 ? 'SYSTEM_OPTIMIZED' : 'IN_PROGRESS'}</span>
                 <span>Target Vector: {target} Units</span>
               </div>
             </div>

             <div className="grid grid-cols-2 gap-8">
                <div className="p-8 bg-black/40 rounded-[24px] border border-white/5 border-l-4 border-l-axx-blue">
                   <div className="text-5xl font-black text-white tracking-tighter mb-1">{resolved}</div>
                   <div className="text-xs text-slate-500 uppercase tracking-widest font-bold">Nodes Resolved</div>
                </div>
                <div className="p-8 bg-black/40 rounded-[24px] border border-white/5 border-l-4 border-l-axx-light">
                   <div className="text-5xl font-black text-white tracking-tighter mb-1">{target}</div>
                   <div className="text-xs text-slate-500 uppercase tracking-widest font-bold">Target Threshold</div>
                </div>
             </div>
          </div>
          
          <div className="mt-12 p-6 bg-black/40 border border-white/5 rounded-2xl max-w-2xl mx-auto text-left flex gap-4">
             <Brain size={24} className="text-axx-purple flex-shrink-0" />
             <div className="space-y-1">
                <div className="text-xs font-bold text-axx-purple uppercase tracking-widest">AI Agent Analysis</div>
                <p className="text-xs text-slate-400 leading-relaxed italic">System note: Current cycle performance is operating within optimized parameters. Total node resolution is {resolved} out of {target} expected vectors. Integrity remains nominal.</p>
             </div>
          </div>
       </div>
    </div>
  );
}
