'use client';

import { MutableRefObject, useMemo, useRef, useState } from 'react';
import {
  Play,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Search,
  Pause
} from 'lucide-react';

import { Button } from '@/components/ui/button';
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

async function limitConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop?: MutableRefObject<boolean>
) {
  let nextIndex = 0;

  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(async () => {
      while (true) {
        if (shouldStop?.current) {
          break;
        }

        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) {
          break;
        }

        await fn(items[currentIndex], currentIndex);
      }
    });

  await Promise.all(workers);
}

export default function Home() {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [targetType, setTargetType] = useState('codex');
  const [provider, setProvider] = useState('');
  const [workers, setWorkers] = useState(20);
  const [timeout, setTimeoutSec] = useState(12);
  const [userAgent, setUserAgent] = useState('codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal');
  const [chatgptAccountId, setChatgptAccountId] = useState('');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [scanStopped, setScanStopped] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [search, setSearch] = useState('');

  const scanAbortController = useRef<AbortController | null>(null);
  const shouldAbortRef = useRef(false);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredAccounts = useMemo(() => {
    if (!normalizedSearch) return accounts;
    return accounts.filter(acc => {
      const name = (acc.name || '').toLowerCase();
      const accountValue = (acc.account || '').toLowerCase();
      const email = (acc.email || '').toLowerCase();
      return [name, accountValue, email].some(field => field.includes(normalizedSearch));
    });
  }, [accounts, normalizedSearch]);

  const invalidCount = useMemo(() => accounts.filter(a => a.invalid_401).length, [accounts]);
  const isDeletingAny = useMemo(() => accounts.some(acc => acc.isDeleting), [accounts]);

  const progressPercentage = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const progressLabel = useMemo(() => {
    if (isStopping) return '正在停止扫描...';
    if (scanStopped && !isChecking) return '扫描已停止';
    if (progress.total === 0) return '尚未开始';
    if (progress.current >= progress.total) return '检测完成';
    return `${progress.current} / ${progress.total}`;
  }, [isStopping, scanStopped, isChecking, progress]);

  const updateAccount = (index: number, changes: Partial<Account>) => {
    setAccounts(prev => {
      const target = prev[index];
      if (!target) return prev;
      const next = [...prev];
      next[index] = { ...target, ...changes };
      return next;
    });
  };

  const startCheck = async () => {
    if (!baseUrl || !token) {
      alert('请填入 Base URL 和 Token');
      return;
    }

    shouldAbortRef.current = false;
    setScanStopped(false);
    setIsStopping(false);
    setIsChecking(true);
    setAccounts([]);
    setProgress({ current: 0, total: 0 });

    const normalizedBaseUrl = baseUrl.replace(/\/+/g, '/').replace(/\/+$/, '');
    const controller = new AbortController();
    scanAbortController.current = controller;

    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: normalizedBaseUrl, token, timeout }),
        signal: controller.signal,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || '获取账号列表失败');
      }

      const allFiles = data.files || [];
      const candidates = allFiles.filter((f: any) => {
        const type = (f.type || f.typo || '').toLowerCase();
        if (type !== targetType.toLowerCase()) return false;
        if (provider && (f.provider || '').toLowerCase() !== provider.toLowerCase()) return false;
        return true;
      });

      setAccounts(candidates.map((c: any) => ({
        ...c,
        account: c.account || c.email || '',
        status_code: null,
        invalid_401: false,
        error: null,
      })));

      setProgress({ current: 0, total: candidates.length });

      if (candidates.length === 0) {
        return;
      }

      await limitConcurrency(candidates, workers, async (item, index) => {
        try {
          const innerController = scanAbortController.current;
          if (!innerController) return;

          const chatgpt_account_id =
            item.chatgpt_account_id ||
            item.chatgptAccountId ||
            item.account_id ||
            item.accountId ||
            chatgptAccountId;

          const payload = {
            authIndex: item.auth_index,
            method: 'GET',
            url: 'https://chatgpt.com/backend-api/wham/usage',
            header: {
              Authorization: 'Bearer $TOKEN$',
              'Content-Type': 'application/json',
              'User-Agent': userAgent,
              ...(chatgpt_account_id ? { 'Chatgpt-Account-Id': chatgpt_account_id } : {}),
            },
          };

          let attempts = 0;
          while (true) {
            if (innerController.signal.aborted) {
              return;
            }

            try {
              const probeRes = await fetch('/api/probe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseUrl: normalizedBaseUrl, token, payload, timeout }),
                signal: innerController.signal,
              });

              const probeData = await probeRes.json();
              if (!probeRes.ok) {
                throw new Error(probeData?.error || `探测返回 ${probeRes.status}`);
              }

              const statusCode = probeData.status_code;
              updateAccount(index, {
                status_code: statusCode,
                invalid_401: statusCode === 401,
                error: statusCode === null ? 'Missing status_code' : null,
              });
              break;
            } catch (err: unknown) {
              if (innerController.signal.aborted) {
                return;
              }

              if (attempts >= 1) {
                throw err;
              }

              attempts += 1;
            }
          }
        } catch (err: unknown) {
          const error = err as Error;
          if (scanAbortController.current?.signal.aborted) {
            return;
          }

          updateAccount(index, { error: error.message });
        } finally {
          setProgress(prev => ({ ...prev, current: prev.current + 1 }));
        }
      }, shouldAbortRef);
    } catch (err: unknown) {
      const error = err as Error;
      if (!scanAbortController.current?.signal.aborted) {
        alert(error.message);
      }
    } finally {
      const wasStopped = shouldAbortRef.current;
      setIsStopping(false);
      setIsChecking(false);
      setScanStopped(wasStopped);
      scanAbortController.current = null;
    }
  };

  const stopScan = () => {
    if (!isChecking || isStopping) return;
    shouldAbortRef.current = true;
    setIsStopping(true);
    setScanStopped(true);
    scanAbortController.current?.abort();
  };

  const deleteInvalid = async () => {
    const invalidAccounts = accounts.filter(a => a.invalid_401);
    if (invalidAccounts.length === 0) return;

    if (!confirm(`确定要删除这 ${invalidAccounts.length} 个失效账号吗？`)) return;

    const normalizedBaseUrl = baseUrl.replace(/\/+/g, '/').replace(/\/+$/, '');

    await limitConcurrency(accounts, 5, async (acc, index) => {
      if (!acc.invalid_401) return;

      updateAccount(index, { isDeleting: true });

      try {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: normalizedBaseUrl, token, name: acc.name, timeout }),
        });

        const ok = res.status === 200;
        updateAccount(index, {
          isDeleting: false,
          deleteStatus: ok ? 'success' : 'failed',
        });
      } catch (error) {
        updateAccount(index, {
          isDeleting: false,
          deleteStatus: 'failed',
        });
      }
    });

    alert('批量删除操作完成');
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-macaron-cream/90 via-macaron-lavender/70 to-macaron-cream py-10">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Code401Check Web</h1>
            <p className="text-sm text-gray-600 mt-1">批量检查并清理失效的 Codex 账号</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={startCheck} disabled={isChecking}>
              {isChecking ? <Loader2 className="animate-spin w-4 h-4" /> : <Play className="w-4 h-4" />}
              <span className="ml-2">开始检测</span>
            </Button>
            <Button variant="danger" onClick={stopScan} disabled={!isChecking || isStopping}>
              <Pause className="w-4 h-4" />
              <span className="ml-2">停止扫描</span>
            </Button>
            <Button
              variant="secondary"
              onClick={deleteInvalid}
              disabled={invalidCount === 0 || isDeletingAny}
              className="gap-2"
            >
              <Trash2 className="w-4 h-4" />
              <span>删除失效 ({invalidCount})</span>
            </Button>
          </div>
        </div>

        <section className="grid gap-4 bg-white/80 border border-white/60 rounded-2xl shadow-macaron p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-gray-600">
              Base URL
              <input
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://your-cpa-address"
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-macaron-cream/90 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-peach"
              />
            </label>
            <label className="text-sm font-medium text-gray-600">
              Management Token
              <input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="Bearer token..."
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-macaron-peach/50 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-mint"
              />
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            <label className="text-sm font-medium text-gray-600">
              Target Type
              <input
                value={targetType}
                onChange={e => setTargetType(e.target.value)}
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-apricot"
              />
            </label>
            <label className="text-sm font-medium text-gray-600">
              Provider (可选)
              <input
                value={provider}
                onChange={e => setProvider(e.target.value)}
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-lavender"
              />
            </label>
            <label className="text-sm font-medium text-gray-600">
              并发线程
              <input
                type="number"
                value={workers}
                min={1}
                onChange={e => setWorkers(parseInt(e.target.value) || 1)}
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-mint"
              />
            </label>
            <label className="text-sm font-medium text-gray-600">
              超时 (秒)
              <input
                type="number"
                value={timeout}
                min={1}
                onChange={e => setTimeoutSec(parseInt(e.target.value) || 1)}
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-apricot"
              />
            </label>
          </div>
        </section>

        {progress.total > 0 && (
          <section className="bg-white/70 border border-white/60 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between text-sm text-gray-700">
              <span>进度：{progressLabel}</span>
              <span>{progressPercentage}%</span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-white/40">
              <div
                className="h-full rounded-full bg-gradient-to-r from-macaron-peach to-macaron-mint transition-all"
                style={{ width: `${progressPercentage}%` }}
              />
            </div>
          </section>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索账号名或邮箱..."
            className="w-full rounded-2xl border border-zinc-200 bg-white/70 px-4 py-2 pl-10 text-sm text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-mint"
          />
        </div>

        <section className="bg-white/90 border border-white/60 rounded-2xl shadow-macaron overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/70 text-gray-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">账号名称</th>
                  <th className="px-4 py-3 font-semibold">账号/邮箱</th>
                  <th className="px-4 py-3 font-semibold text-center">状态码</th>
                  <th className="px-4 py-3 font-semibold">结果/错误</th>
                  <th className="px-4 py-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {filteredAccounts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                      暂无数据，请填入配置并开始检测
                    </td>
                  </tr>
                ) : (
                  filteredAccounts.map((acc, index) => (
                    <tr
                      key={`${acc.name}-${index}`}
                      className={cn(
                        'transition-colors hover:bg-macaron-cream/70',
                        acc.invalid_401 && 'bg-red-50/80'
                      )}
                    >
                      <td className="px-4 py-3 font-medium text-gray-800">{acc.name}</td>
                      <td className="px-4 py-3 text-gray-600">{acc.account}</td>
                      <td className="px-4 py-3 text-center">
                        {acc.status_code != null && (
                          <span
                            className={cn(
                              'px-2 py-1 rounded-full text-xs font-semibold',
                              acc.status_code === 401
                                ? 'bg-rose-100 text-rose-700'
                                : 'bg-emerald-100 text-emerald-700'
                            )}
                          >
                            {acc.status_code}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {acc.invalid_401 ? (
                          <span className="flex items-center gap-1 text-rose-600">
                            <AlertCircle className="w-4 h-4" /> 已失效 (401)
                          </span>
                        ) : acc.status_code ? (
                          <span className="flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="w-4 h-4" /> 正常
                          </span>
                        ) : acc.error ? (
                          <span className="text-rose-500 line-clamp-2" title={acc.error}>{acc.error}</span>
                        ) : (
                          <span className="text-zinc-400">等待检测...</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {acc.deleteStatus === 'success' ? (
                          <span className="text-zinc-400 text-xs italic">已移除</span>
                        ) : acc.isDeleting ? (
                          <Loader2 className="w-4 h-4 animate-spin inline" />
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
        </section>
      </div>
    </main>
  );
}
