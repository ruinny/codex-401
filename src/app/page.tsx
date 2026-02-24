'use client';

import { MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Search,
  Pause,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { cn } from '@/lib/utils';

type ResultState = 'unknown' | 'normal' | 'failed';
type ResultFilter = 'all' | 'normal' | 'failed' | 'unknown';

interface ProbeTarget {
  auth_index?: string;
  chatgpt_account_id?: string;
  chatgptAccountId?: string;
  account_id?: string;
  accountId?: string;
}

interface Account extends ProbeTarget {
  name: string;
  account?: string;
  email?: string;
  type?: string;
  typo?: string;
  provider?: string;
  status_code?: number | null;
  invalid_401?: boolean;
  result?: ResultState;
  error?: string | null;
  isDeleting?: boolean;
  deleteStatus?: 'success' | 'failed' | null;
}

const MIN_WORKERS = 1;
const MAX_WORKERS = 10;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 120;
const PAGE_SIZE = 100;
const DELETE_CONCURRENCY = 5;
const SEARCH_DEBOUNCE_MS = 250;
const SCAN_FLUSH_INTERVAL_MS = 80;
const SCAN_FLUSH_BATCH_SIZE = 20;
const PROBE_RETRY_LIMIT = 1;
const SCAN_RECHECK_ROUNDS = 3;
const SCAN_RECHECK_DELAY_MS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const clampInteger = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const parseBoundedInt = (value: string, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return clampInteger(parsed, min, max);
};

const normalizeBaseUrl = (raw: string): string => {
  let parsed: URL;

  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Base URL 格式无效');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL 仅支持 http/https');
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const basePath = normalizedPath === '/' ? '' : normalizedPath;
  return `${parsed.origin}${basePath}`;
};

const extractApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!isRecord(payload)) {
    return fallback;
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }

  const error = payload.error;
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }

  return fallback;
};

const getOptionalString = (value: unknown): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  return String(value);
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) {
        onAbort();
      }
    }
  });
};

async function limitConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop?: MutableRefObject<boolean>
) {
  if (items.length === 0) {
    return;
  }

  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = clampInteger(normalizedConcurrency || 1, 1, items.length);

  let nextIndex = 0;

  const workers = Array(workerCount)
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
  const targetType = 'codex';
  const provider = '';
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
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [page, setPage] = useState(1);

  const scanAbortController = useRef<AbortController | null>(null);
  const shouldAbortRef = useRef(false);

  const pendingAccountUpdatesRef = useRef(new Map<number, Partial<Account>>());
  const pendingProgressRef = useRef(0);
  const scanFlushTimerRef = useRef<number | null>(null);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const normalizedSearch = debouncedSearch.trim().toLowerCase();

  const filteredAccounts = useMemo(() => {
    return accounts.filter(acc => {
      if (resultFilter === 'normal' && acc.result !== 'normal') {
        return false;
      }

      if (resultFilter === 'failed' && acc.result !== 'failed') {
        return false;
      }

      if (resultFilter === 'unknown' && acc.result !== 'unknown') {
        return false;
      }

      if (!normalizedSearch) return true;

      const name = (acc.name || '').toLowerCase();
      const accountValue = (acc.account || '').toLowerCase();
      const email = (acc.email || '').toLowerCase();
      return [name, accountValue, email].some(field => field.includes(normalizedSearch));
    });
  }, [accounts, normalizedSearch, resultFilter]);

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
  }, [filteredAccounts.length]);

  useEffect(() => {
    setPage(prev => Math.min(prev, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setPage(1);
  }, [normalizedSearch, resultFilter]);

  const pagedAccounts = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredAccounts.slice(start, start + PAGE_SIZE);
  }, [filteredAccounts, page]);

  const pageStart = filteredAccounts.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, filteredAccounts.length);

  const failedCount = useMemo(() => accounts.filter(a => a.result === 'failed').length, [accounts]);
  const normalCount = useMemo(() => accounts.filter(a => a.result === 'normal').length, [accounts]);
  const unknownCount = useMemo(() => accounts.filter(a => a.result === 'unknown').length, [accounts]);
  const isDeletingAny = useMemo(() => accounts.some(acc => acc.isDeleting), [accounts]);

  const progressPercentage = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const progressLabel = useMemo(() => {
    if (isStopping) return '正在停止扫描...';
    if (scanStopped && !isChecking) return '扫描已停止';
    if (progress.total === 0) return '尚未开始';
    if (progress.current >= progress.total) return '检测完成';
    return `${progress.current} / ${progress.total}`;
  }, [isStopping, scanStopped, isChecking, progress]);

  const flushPendingScanState = () => {
    const pendingEntries = Array.from(pendingAccountUpdatesRef.current.entries());
    const pendingProgress = pendingProgressRef.current;

    if (pendingEntries.length > 0) {
      pendingAccountUpdatesRef.current.clear();
      setAccounts(prev => {
        if (prev.length === 0) return prev;

        const next = [...prev];
        for (const [index, changes] of pendingEntries) {
          const current = next[index];
          if (!current) continue;
          next[index] = { ...current, ...changes };
        }

        return next;
      });
    }

    if (pendingProgress > 0) {
      pendingProgressRef.current = 0;
      setProgress(prev => ({
        ...prev,
        current: Math.min(prev.total, prev.current + pendingProgress),
      }));
    }
  };

  const clearScanFlushTimer = () => {
    if (scanFlushTimerRef.current !== null) {
      window.clearTimeout(scanFlushTimerRef.current);
      scanFlushTimerRef.current = null;
    }
  };

  const scheduleScanFlush = () => {
    if (
      pendingAccountUpdatesRef.current.size >= SCAN_FLUSH_BATCH_SIZE
      || pendingProgressRef.current >= SCAN_FLUSH_BATCH_SIZE
    ) {
      clearScanFlushTimer();
      flushPendingScanState();
      return;
    }

    if (scanFlushTimerRef.current !== null) {
      return;
    }

    scanFlushTimerRef.current = window.setTimeout(() => {
      scanFlushTimerRef.current = null;
      flushPendingScanState();
    }, SCAN_FLUSH_INTERVAL_MS);
  };

  const queueScanAccountUpdate = (index: number, changes: Partial<Account>) => {
    const existing = pendingAccountUpdatesRef.current.get(index);
    pendingAccountUpdatesRef.current.set(index, existing ? { ...existing, ...changes } : changes);
    scheduleScanFlush();
  };

  const queueProgressTick = () => {
    pendingProgressRef.current += 1;
    scheduleScanFlush();
  };

  const resetScanBuffers = () => {
    pendingAccountUpdatesRef.current.clear();
    pendingProgressRef.current = 0;
    clearScanFlushTimer();
  };

  useEffect(() => {
    return () => {
      clearScanFlushTimer();
    };
  }, []);

  const updateAccountImmediate = (index: number, changes: Partial<Account>) => {
    setAccounts(prev => {
      const target = prev[index];
      if (!target) return prev;

      const next = [...prev];
      next[index] = { ...target, ...changes };
      return next;
    });
  };

  const buildProbePayload = (target: ProbeTarget) => {
    const chatgptAccountSource =
      target.chatgpt_account_id
      ?? target.chatgptAccountId
      ?? target.account_id
      ?? target.accountId
      ?? chatgptAccountId;

    const chatgpt_account_id = chatgptAccountSource == null ? '' : String(chatgptAccountSource);

    return {
      authIndex: target.auth_index,
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/wham/usage',
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        ...(chatgpt_account_id ? { 'Chatgpt-Account-Id': chatgpt_account_id } : {}),
      },
    };
  };

  const probeAccountStatus = async (
    params: {
      normalizedBaseUrl: string;
      token: string;
      timeoutSeconds: number;
      target: ProbeTarget;
      signal?: AbortSignal;
    }
  ): Promise<number | null> => {
    const { normalizedBaseUrl, token: requestToken, timeoutSeconds, target, signal } = params;

    const payload = buildProbePayload(target);

    let attempts = 0;
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      try {
        const probeRes = await fetch('/api/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: normalizedBaseUrl,
            token: requestToken,
            payload,
            timeout: timeoutSeconds,
          }),
          signal,
        });

        const probeData: unknown = await probeRes.json().catch(() => ({}));
        if (!probeRes.ok) {
          throw new Error(extractApiErrorMessage(probeData, `探测返回 ${probeRes.status}`));
        }

        const statusCode = isRecord(probeData) && typeof probeData.status_code === 'number'
          ? probeData.status_code
          : null;

        return statusCode;
      } catch (err: unknown) {
        if (signal?.aborted) {
          throw err;
        }

        if (attempts >= PROBE_RETRY_LIMIT) {
          throw err;
        }

        attempts += 1;
      }
    }
  };

  const classifyFromStatuses = (
    statuses: number[]
  ): { result: ResultState; status_code: number | null; invalid_401: boolean } => {
    if (statuses.length === 0) {
      return {
        result: 'unknown',
        status_code: null,
        invalid_401: false,
      };
    }

    const count401 = statuses.filter(code => code === 401).length;
    const countNon401 = statuses.length - count401;

    if (count401 >= 2) {
      return {
        result: 'failed',
        status_code: 401,
        invalid_401: true,
      };
    }

    if (countNon401 >= 2) {
      const latestNon401 = [...statuses].reverse().find(code => code !== 401) ?? statuses[statuses.length - 1];
      return {
        result: 'normal',
        status_code: latestNon401,
        invalid_401: false,
      };
    }

    return {
      result: 'unknown',
      status_code: statuses[statuses.length - 1] ?? null,
      invalid_401: false,
    };
  };

  const startCheck = async () => {
    if (isChecking) return;

    if (!baseUrl || !token) {
      alert('请填入 Base URL 和 Token');
      return;
    }

    let normalizedBaseUrl = '';
    try {
      normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Base URL 格式无效';
      alert(message);
      return;
    }

    const safeWorkers = clampInteger(workers, MIN_WORKERS, MAX_WORKERS);
    const safeTimeout = clampInteger(timeout, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);

    if (safeWorkers !== workers) {
      setWorkers(safeWorkers);
    }

    if (safeTimeout !== timeout) {
      setTimeoutSec(safeTimeout);
    }

    shouldAbortRef.current = false;
    setScanStopped(false);
    setIsStopping(false);
    setIsChecking(true);
    setAccounts([]);
    setPage(1);
    setResultFilter('all');
    setProgress({ current: 0, total: 0 });
    resetScanBuffers();

    const controller = new AbortController();
    scanAbortController.current = controller;

    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: normalizedBaseUrl, token, timeout: safeTimeout }),
        signal: controller.signal,
      });
      const data: unknown = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(extractApiErrorMessage(data, '获取账号列表失败'));
      }

      const allFiles = isRecord(data) && Array.isArray(data.files) ? data.files : [];
      const targetTypeValue = targetType.trim().toLowerCase();
      const providerValue = provider.trim().toLowerCase();

      const candidates: Account[] = allFiles
        .filter((file): file is Record<string, unknown> => {
          if (!isRecord(file)) return false;

          const type = String(file.type ?? file.typo ?? '').toLowerCase();
          if (type !== targetTypeValue) return false;

          if (providerValue) {
            const fileProvider = String(file.provider ?? '').toLowerCase();
            if (fileProvider !== providerValue) return false;
          }

          return true;
        })
        .map(file => ({
          name: String(file.name ?? ''),
          account: String(file.account ?? file.email ?? ''),
          email: getOptionalString(file.email),
          auth_index: getOptionalString(file.auth_index),
          type: getOptionalString(file.type),
          typo: getOptionalString(file.typo),
          provider: getOptionalString(file.provider),
          chatgpt_account_id: getOptionalString(file.chatgpt_account_id),
          chatgptAccountId: getOptionalString(file.chatgptAccountId),
          account_id: getOptionalString(file.account_id),
          accountId: getOptionalString(file.accountId),
          status_code: null,
          invalid_401: false,
          result: 'unknown',
          error: null,
          isDeleting: false,
          deleteStatus: null,
        }));

      setAccounts(candidates);
      setProgress({ current: 0, total: candidates.length });

      if (candidates.length === 0) {
        return;
      }

      await limitConcurrency(candidates, safeWorkers, async (item, index) => {
        try {
          const innerController = scanAbortController.current;
          if (!innerController) return;

          const statuses: number[] = [];
          let probeError: string | null = null;

          for (let round = 0; round < SCAN_RECHECK_ROUNDS; round += 1) {
            if (innerController.signal.aborted) {
              return;
            }

            try {
              const status = await probeAccountStatus({
                normalizedBaseUrl,
                token,
                timeoutSeconds: safeTimeout,
                target: item,
                signal: innerController.signal,
              });

              if (typeof status === 'number') {
                statuses.push(status);
              } else {
                probeError = '探测缺少 status_code';
              }
            } catch (err: unknown) {
              probeError = err instanceof Error ? err.message : '探测失败';
            }

            if (round < SCAN_RECHECK_ROUNDS - 1) {
              await sleep(SCAN_RECHECK_DELAY_MS, innerController.signal);
            }
          }

          const finalResult = classifyFromStatuses(statuses);
          queueScanAccountUpdate(index, {
            status_code: finalResult.status_code,
            invalid_401: finalResult.invalid_401,
            result: finalResult.result,
            error: finalResult.result === 'unknown' ? (probeError || '复检结果不足，暂不判定失败') : null,
          });
        } catch (err: unknown) {
          if (scanAbortController.current?.signal.aborted) {
            return;
          }

          const message = err instanceof Error ? err.message : '探测失败';
          queueScanAccountUpdate(index, {
            result: 'unknown',
            invalid_401: false,
            error: message,
          });
        } finally {
          queueProgressTick();
        }
      }, shouldAbortRef);
    } catch (err: unknown) {
      const error = err as Error;
      if (!scanAbortController.current?.signal.aborted) {
        alert(error.message);
      }
    } finally {
      clearScanFlushTimer();
      flushPendingScanState();

      const wasStopped = shouldAbortRef.current;
      setIsStopping(false);
      setIsChecking(false);
      setScanStopped(wasStopped);
      scanAbortController.current = null;
      shouldAbortRef.current = false;
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
    const failedAccounts = accounts.filter(a => a.result === 'failed');
    if (failedAccounts.length === 0) return;

    if (!confirm(`确定要删除这 ${failedAccounts.length} 个失败账号吗？`)) return;

    let normalizedBaseUrl = '';
    try {
      normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Base URL 格式无效';
      alert(message);
      return;
    }

    const safeTimeout = clampInteger(timeout, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
    if (safeTimeout !== timeout) {
      setTimeoutSec(safeTimeout);
    }

    await limitConcurrency(accounts, DELETE_CONCURRENCY, async (acc, index) => {
      if (acc.result !== 'failed') return;

      updateAccountImmediate(index, { isDeleting: true });

      try {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: normalizedBaseUrl,
            token,
            name: acc.name,
            timeout: safeTimeout,
          }),
        });

        updateAccountImmediate(index, {
          isDeleting: false,
          deleteStatus: res.ok ? 'success' : 'failed',
        });
      } catch {
        updateAccountImmediate(index, {
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
              disabled={failedCount === 0 || isDeletingAny || isChecking}
              className="gap-2"
            >
              <Trash2 className="w-4 h-4" />
              <span>删除失败账号 ({failedCount})</span>
            </Button>
          </div>
        </div>

        <section className="bg-white/75 border border-white/60 rounded-2xl shadow-sm p-4 text-xs md:text-sm text-gray-700 space-y-2">
          <p className="font-semibold text-gray-800">功能与逻辑说明</p>
          <p>
            功能：批量检测账号状态，按“全部 / 正常 / 失败 / 未知”筛选，并支持批量删除失败账号。
          </p>
          <p>
            逻辑：每个账号默认进行 3 轮探测，若 401 次数 ≥ 2 判定为失败；非 401 次数 ≥ 2 判定为正常；超时或证据不足归为未知，不进入删除。
          </p>
        </section>

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
          <div className="grid gap-4 md:grid-cols-3">
            <div className="text-sm font-medium text-gray-600">
              Target Type
              <div className="w-full mt-1 rounded-2xl border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-gray-700">
                codex
              </div>
            </div>
            <label className="text-sm font-medium text-gray-600">
              并发线程
              <input
                type="number"
                value={workers}
                min={MIN_WORKERS}
                max={MAX_WORKERS}
                onChange={e => setWorkers(parseBoundedInt(e.target.value, MIN_WORKERS, MIN_WORKERS, MAX_WORKERS))}
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-mint"
              />
            </label>
            <label className="text-sm font-medium text-gray-600">
              超时 (秒)
              <input
                type="number"
                value={timeout}
                min={MIN_TIMEOUT_SECONDS}
                max={MAX_TIMEOUT_SECONDS}
                onChange={e => setTimeoutSec(parseBoundedInt(e.target.value, MIN_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS))}
                className="w-full mt-1 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-apricot"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-gray-600">
            <span>失败：{failedCount}</span>
            <span>正常：{normalCount}</span>
            <span>未知：{unknownCount}</span>
          </div>
        </section>

        {progress.total > 0 && (
          <section className="bg-white/70 border border-white/60 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between text-sm text-gray-700">
              <span>扫描进度：{progressLabel}</span>
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

        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索账号名或邮箱..."
              className="w-full rounded-2xl border border-zinc-200 bg-white/70 px-4 py-2 pl-10 text-sm text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-mint"
            />
          </div>

          <label className="text-sm font-medium text-gray-600 flex items-center gap-2 md:justify-end">
            按结果筛选
            <select
              value={resultFilter}
              onChange={e => setResultFilter(e.target.value as ResultFilter)}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-macaron-mint"
            >
              <option value="all">全部</option>
              <option value="normal">正常</option>
              <option value="failed">失败</option>
              <option value="unknown">未知</option>
            </select>
          </label>
        </div>

        <section className="bg-white/90 border border-white/60 rounded-2xl shadow-macaron overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <span className="text-xs text-gray-600">
              {filteredAccounts.length === 0
                ? '当前无匹配结果'
                : `显示 ${pageStart}-${pageEnd} / ${filteredAccounts.length} 条`}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page === 1}
                  onClick={() => setPage(prev => Math.max(1, prev - 1))}
                >
                  上一页
                </Button>
                <span className="text-xs text-gray-600">{page} / {totalPages}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page >= totalPages}
                  onClick={() => setPage(prev => Math.min(totalPages, prev + 1))}
                >
                  下一页
                </Button>
              </div>
            )}
          </div>

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
                {pagedAccounts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                      暂无数据，请填入配置并开始检测
                    </td>
                  </tr>
                ) : (
                  pagedAccounts.map((acc, index) => {
                    const absoluteIndex = (page - 1) * PAGE_SIZE + index;
                    const rowKey = `${acc.name}-${acc.auth_index ?? acc.account ?? acc.email ?? absoluteIndex}`;

                    return (
                      <tr
                        key={rowKey}
                        className={cn(
                          'transition-colors hover:bg-macaron-cream/70',
                          acc.result === 'failed' && 'bg-red-50/80',
                          acc.result === 'unknown' && 'bg-amber-50/80'
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
                          {acc.result === 'failed' ? (
                            <div className="text-rose-600">
                              <span className="flex items-center gap-1">
                                <AlertCircle className="w-4 h-4" /> 失败（确认 401）
                              </span>
                              {acc.error && <span className="text-xs text-rose-500">{acc.error}</span>}
                            </div>
                          ) : acc.result === 'normal' ? (
                            <span className="flex items-center gap-1 text-emerald-600">
                              <CheckCircle2 className="w-4 h-4" /> 正常
                            </span>
                          ) : (
                            <div className="text-amber-600">
                              <span className="flex items-center gap-1">
                                <AlertCircle className="w-4 h-4" /> 未知（超时/证据不足）
                              </span>
                              {acc.error && <span className="text-xs text-amber-500">{acc.error}</span>}
                            </div>
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
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
