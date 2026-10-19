import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Workspace } from '../domain/types';
import { workspaceRepository } from '../services/workspace';

interface WorkspaceContextValue {
  data: Workspace | null;
  update: (change: (data: Workspace) => Workspace) => void;
  reset: () => Promise<void>;
  notify: (message: string) => void;
  toast: string;
}
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Workspace | null>(null);
  const [toast, setToast] = useState('');
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    workspaceRepository
      .load()
      .then(setData)
      .catch(() => notify('无法读取本地演示数据，请检查浏览器存储权限'));
  }, [notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (data)
      workspaceRepository.save(data).catch(() => notify('浏览器存储不可用，刷新后本次修改将丢失'));
  }, [data, notify]);
  const update = (change: (data: Workspace) => Workspace) =>
    setData((current) => (current ? change(current) : current));
  const reset = async () => {
    setData(await workspaceRepository.reset());
    notify('演示数据已恢复');
  };
  return (
    <WorkspaceContext.Provider value={{ data, update, reset, notify, toast }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('缺少 WorkspaceProvider');
  return context;
}
