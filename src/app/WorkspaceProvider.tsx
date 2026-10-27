import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface WorkspaceContextValue {
  notify: (message: string) => void;
  toast: string;
}
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState('');
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <WorkspaceContext.Provider value={{ notify, toast }}>{children}</WorkspaceContext.Provider>
  );
}
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('缺少 WorkspaceProvider');
  return context;
}
