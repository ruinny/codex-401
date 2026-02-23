'use client';

import React, { useState, useMemo } from 'react';
import {
  Play,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Search
} from 'lucide-react';

// Simple concurrency limiter to replace p-limit if needed
async function limitConcurrency<T>(
  items: any[],
  concurrency: number,
  fn: (item: any, index: number) => Promise<T>
) {
  const results: T[] = [];
  const queue = [...items.entries()];
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(async () => {
      for (const [index, item] of queue) {
        results[index] = await fn(item, index);
      }
    });
  await Promise.all(workers);
  return results;
}

import { cn } from '@/lib/utils';

interface Account {
  name: string;
  account?: string;
  email?: string;
  auth_index?: string;
  type?: string;
  typo?: string;
  provider?: string;
  status_code?: number | null;
  invalid_401?: boolean;
  error?: string | null;
  isDeleting?: boolean;
  deleteStatus?: 'success' | 'failed' | null;
}

export default function Home() {
  // Config state
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [targetType, setTargetType] = useState('codex');
  const [provider, setProvider] = useState('');
  const [workers, setWorkers] = useState(20);
  const [timeout, setTimeoutSec] = useState(12);
  const [userAgent, setUserAgent] = useState('codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal');
  const [chatgptAccountId, setChatgptAccountId] = useState('');

  // App state
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [search, setSearch] = useState('');

  // Filter accounts
  const filteredAccounts = useMemo(() => {
    return accounts.filter(acc =>
      (acc.name?.toLowerCase().includes(search.toLowerCase()) ||
       acc.account?.toLowerCase().includes(search.toLowerCase()) ||
       acc.email?.toLowerCase().includes(search.toLowerCase()))
    );
  }, [accounts, search]);

  const invalidCount = useMemo(() => accounts.filter(a => a.invalid_401).length, [accounts]);

  const startCheck = async () => {
    if (!baseUrl || !token) {
      alert('请填入 Base URL 和 Token');
      return;
    }

    setIsChecking(true);
    setAccounts([]);
    setProgress({ current: 0, total: 0 });

    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

    try {
      // 1. Fetch accounts
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: normalizedBaseUrl, token, timeout }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || '获取账号列表失败');

      const allFiles = data.files || [];
      const candidates = allFiles.filter((f: any) => {
        const type = f.type || f.typo || '';
        if (type.toLowerCase() !== targetType.toLowerCase()) return false;
        if (provider && (f.provider || '').toLowerCase() !== provider.toLowerCase()) return false;
        return true;
      });

      setAccounts(candidates.map((c: any) => ({
        ...c,
        account: c.account || c.email || '',
        status_code: null,
        invalid_401: false,
        error: null
      })));
      setProgress({ current: 0, total: candidates.length });

      // 2. Probe accounts
      await limitConcurrency(candidates, workers, async (item, index) => {
        try {
          const chatgpt_account_id = item.chatgpt_account_id || item.chatgptAccountId || item.account_id || item.accountId || chatgptAccountId;

          const payload = {
            authIndex: item.auth_index,
            method: 'GET',
            url: 'https://chatgpt.com/backend-api/wham/usage',
            header: {
              'Authorization': 'Bearer $TOKEN$',
              'Content-Type': 'application/json',
              'User-Agent': userAgent,
              ...(chatgpt_account_id ? { 'Chatgpt-Account-Id': chatgpt_account_id } : {})
            }
          };

          const probeRes = await fetch('/api/probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: normalizedBaseUrl, token, payload, timeout }),
          });

          const probeData = await probeRes.json();
          const statusCode = probeData.status_code;

          setAccounts(prev => prev.map((acc, i) => i === index ? {
            ...acc,
            status_code: statusCode,
            invalid_401: statusCode === 401,
            error: statusCode === null ? 'Missing status_code' : null
          } : acc));

        } catch (err: any) {
          setAccounts(prev => prev.map((acc, i) => i === index ? {
            ...acc,
            error: err.message
          } : acc));
        } finally {
          setProgress(prev => ({ ...prev, current: prev.current + 1 }));
        }
      });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsChecking(false);
    }
  };

  const deleteInvalid = async () => {
    const invalidAccounts = accounts.filter(a => a.invalid_401);
    if (invalidAccounts.length === 0) return;

    if (!confirm(`确定要删除这 ${invalidAccounts.length} 个失效账号吗？`)) return;

    await limitConcurrency(accounts, 5, async (acc, index) => {
      if (!acc.invalid_401) return;

      const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

      setAccounts(prev => prev.map((a, i) => i === index ? { ...a, isDeleting: true } : a));
      try {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: normalizedBaseUrl, token, name: acc.name, timeout }),
        });

        // As long as the request returns 200, we consider it a success.
        // Even if some specific CPA node returns 404, if the main distributor returns 200, it's ok.
        const ok = res.status === 200;

        setAccounts(prev => prev.map((a, i) => i === index ? {
          ...a,
          isDeleting: false,
          deleteStatus: ok ? 'success' : 'failed'
        } : a));
      } catch (err) {
        setAccounts(prev => prev.map((a, i) => i === index ? {
          ...a,
          isDeleting: false,
          deleteStatus: 'failed'
        } : a));
      }
    });

    alert('批量删除操作完成');
  };

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Code401Check Web</h1>
          <p className="text-muted-foreground mt-1">批量检查并清理失效的 Codex 账号</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={startCheck}
            disabled={isChecking}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-4 py-2 rounded-lg transition-colors"
          >
            {isChecking ? <Loader2 className="animate-spin w-4 h-4" /> : <Play className="w-4 h-4" />}
            开始检测
          </button>
          <button
            onClick={deleteInvalid}
            disabled={isChecking || invalidCount === 0}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white px-4 py-2 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            删除失效 ({invalidCount})
          </button>
        </div>
      </div>

      {/* Config Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-6 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
        <div className="space-y-2 lg:col-span-2">
          <label className="text-sm font-medium">Base URL</label>
          <input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="http://your-cpa-address"
            className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div className="space-y-2 lg:col-span-2">
          <label className="text-sm font-medium">Management Token</label>
          <input
            value={token}
            onChange={e => setToken(e.target.value)}
            type="password"
            placeholder="Bearer token..."
            className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Target Type</label>
          <input
            value={targetType}
            onChange={e => setTargetType(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Provider (可选)</label>
          <input
            value={provider}
            onChange={e => setProvider(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">并发线程 (Workers)</label>
          <input
            type="number"
            value={workers}
            onChange={e => setWorkers(parseInt(e.target.value) || 1)}
            className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">超时 (秒)</label>
          <input
            type="number"
            value={timeout}
            onChange={e => setTimeoutSec(parseInt(e.target.value) || 1)}
            className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>

      {/* Progress & Search */}
      <div className="space-y-4">
        {progress.total > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>进度: {progress.current} / {progress.total}</span>
              <span>{Math.round((progress.current / progress.total) * 100)}%</span>
            </div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索账号名或邮箱..."
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Results Table */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-bottom border-zinc-200 dark:border-zinc-800">
                <th className="px-4 py-3 font-semibold">账号名称</th>
                <th className="px-4 py-3 font-semibold">账号/邮箱</th>
                <th className="px-4 py-3 font-semibold text-center">状态码</th>
                <th className="px-4 py-3 font-semibold">结果/错误</th>
                <th className="px-4 py-3 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filteredAccounts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    暂无数据，请填入配置并开始检测
                  </td>
                </tr>
              ) : (
                filteredAccounts.map((acc, i) => (
                  <tr key={i} className={cn(
                    "hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors",
                    acc.invalid_401 && "bg-red-50/50 dark:bg-red-900/10"
                  )}>
                    <td className="px-4 py-3 font-medium">{acc.name}</td>
                    <td className="px-4 py-3 text-zinc-500">{acc.account}</td>
                    <td className="px-4 py-3 text-center">
                      {acc.status_code && (
                        <span className={cn(
                          "px-2 py-1 rounded text-xs font-bold",
                          acc.status_code === 401 ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                        )}>
                          {acc.status_code}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {acc.invalid_401 ? (
                        <span className="flex items-center gap-1 text-red-600">
                          <AlertCircle className="w-4 h-4" /> 已失效 (401)
                        </span>
                      ) : acc.status_code ? (
                        <span className="flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="w-4 h-4" /> 正常
                        </span>
                      ) : acc.error ? (
                        <span className="text-red-500 truncate max-w-xs block" title={acc.error}>{acc.error}</span>
                      ) : (
                        <span className="text-zinc-400">等待检测...</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {acc.deleteStatus === 'success' ? (
                        <span className="text-zinc-400 text-xs italic">已移除</span>
                      ) : acc.isDeleting ? (
                        <Loader2 className="w-4 h-4 animate-spin inline ml-auto" />
                      ) : acc.deleteStatus === 'failed' ? (
                        <span className="text-red-500 text-xs">删除失败</span>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
