'use client';

import { useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastProps {
  toasts: ToastMessage[];
  onRemove: (id: string) => void;
}

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

const STYLES: Record<ToastType, string> = {
  success: 'bg-[color-mix(in_srgb,var(--ok)_14%,var(--panel))] border-[color-mix(in_srgb,var(--ok)_45%,transparent)] text-[var(--ok)]',
  error:   'bg-[color-mix(in_srgb,var(--crit)_14%,var(--panel))] border-[color-mix(in_srgb,var(--crit)_45%,transparent)] text-[var(--crit)]',
  info:    'bg-[color-mix(in_srgb,var(--info)_14%,var(--panel))] border-[color-mix(in_srgb,var(--info)_45%,transparent)] text-[var(--info)]',
  warning: 'bg-[color-mix(in_srgb,var(--warn)_14%,var(--panel))] border-[color-mix(in_srgb,var(--warn)_45%,transparent)] text-[var(--warn)]',
};

export default function Toast({ toasts, onRemove }: ToastProps) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 items-end">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onRemove }: { toast: ToastMessage; onRemove: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onRemove(toast.id), 3500);
    return () => clearTimeout(timer);
  }, [toast.id, onRemove]);

  return (
    <div
      className={[
        'flex items-center gap-2.5 px-4 py-2.5 rounded-lg border text-[13px] font-medium shadow-xl max-w-[320px]',
        'animate-in slide-in-from-right-4 fade-in duration-200',
        STYLES[toast.type],
      ].join(' ')}
    >
      <span className="text-[14px] flex-shrink-0">{ICONS[toast.type]}</span>
      <span className="leading-snug">{toast.message}</span>
      <button
        onClick={() => onRemove(toast.id)}
        className="ml-1 opacity-60 hover:opacity-100 text-[11px] flex-shrink-0"
      >
        ✕
      </button>
    </div>
  );
}
