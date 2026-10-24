import type { ConnectionSettings } from './types';

export interface ConnectionFormState {
  values: Record<string, string>;
  clear: string[];
  reset: string[];
  editingSecrets: string[];
}
export type ConnectionFormAction =
  | { type: 'change'; key: string; value: string }
  | { type: 'edit_secret' | 'cancel_secret'; key: string }
  | { type: 'clear'; key: string; checked: boolean };
export function createConnectionForm(): ConnectionFormState;
export function connectionFormFields(
  settings: ConnectionSettings,
  state: ConnectionFormState,
): (ConnectionSettings['fields'][number] & { cleared: boolean })[];
export function updateConnectionForm(
  settings: ConnectionSettings,
  state: ConnectionFormState,
  action: ConnectionFormAction,
): ConnectionFormState;
export function connectionFormPayload(
  settings: ConnectionSettings,
  state: ConnectionFormState,
): { values: Record<string, string>; clear: string[] };
