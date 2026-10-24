const groups = {
  WEB_SEARCH_PROVIDER: {
    provider: 'tavily',
    fields: ['WEB_SEARCH_API_KEY', 'WEB_SEARCH_BASE_URL'],
    legacy: ['TAVILY_API_KEY'],
  },
  RESEARCH_MODEL_PROVIDER: {
    provider: 'deepseek',
    fields: ['RESEARCH_MODEL_API_KEY', 'RESEARCH_MODEL_BASE_URL', 'RESEARCH_MODEL_MODEL'],
    legacy: ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL'],
  },
  CUSTOMS_PROVIDER: {
    provider: 'billofladingdata',
    fields: ['CUSTOMS_API_KEY', 'CUSTOMS_BASE_URL'],
    legacy: [],
  },
};
const has = (object, key) => Object.hasOwn(object, key);
const fieldMap = (settings) => new Map(settings.fields.map((field) => [field.key, field]));
const storedProvider = (fields, key) => fields.get(key)?.value || groups[key].provider;
const providerFor = (fields, state, key) => state.values[key] || storedProvider(fields, key);
function fallbackKey(key, fields, state) {
  if (
    key === 'WEB_SEARCH_API_KEY' &&
    providerFor(fields, state, 'WEB_SEARCH_PROVIDER') === 'tavily'
  )
    return 'TAVILY_API_KEY';
  if (providerFor(fields, state, 'RESEARCH_MODEL_PROVIDER') === 'deepseek') {
    if (key === 'RESEARCH_MODEL_API_KEY') return 'DEEPSEEK_API_KEY';
    if (key === 'RESEARCH_MODEL_MODEL') return 'DEEPSEEK_MODEL';
  }
  return undefined;
}
function defaultValue(key, fields, state) {
  if (key === 'WEB_SEARCH_BASE_URL')
    return providerFor(fields, state, 'WEB_SEARCH_PROVIDER') === 'tavily'
      ? 'https://api.tavily.com'
      : '';
  if (key === 'RESEARCH_MODEL_BASE_URL')
    return providerFor(fields, state, 'RESEARCH_MODEL_PROVIDER') === 'deepseek'
      ? 'https://api.deepseek.com'
      : '';
  if (key === 'RESEARCH_MODEL_MODEL')
    return providerFor(fields, state, 'RESEARCH_MODEL_PROVIDER') === 'deepseek'
      ? fields.get('DEEPSEEK_MODEL')?.value || 'deepseek-flash'
      : '';
  if (key === 'CUSTOMS_BASE_URL')
    return providerFor(fields, state, 'CUSTOMS_PROVIDER') === 'billofladingdata'
      ? 'https://tradedata.billofladingdata.com'
      : '';
  return '';
}

// Values are user edits only. Effective defaults and masked secrets never enter
// this state, so opening or saving the form cannot persist a displayed fallback.
export function createConnectionForm() {
  return { values: {}, clear: [], reset: [], editingSecrets: [] };
}

export function connectionFormFields(settings, state) {
  const fields = fieldMap(settings);
  return settings.fields
    .filter((field) => !/^(TAVILY_|DEEPSEEK_)/.test(field.key))
    .map((field) => {
      const legacyKey = fallbackKey(field.key, fields, state);
      const legacy = legacyKey && fields.get(legacyKey);
      const reset = state.reset.includes(field.key);
      const source = !reset && field.configured ? field : legacy?.configured ? legacy : null;
      return {
        ...field,
        configured: field.secret ? !!source : (!reset && field.configured) || !!legacy?.configured,
        maskedValue: field.secret ? source?.maskedValue || '' : undefined,
        value: field.secret
          ? state.values[field.key] || ''
          : has(state.values, field.key)
            ? state.values[field.key]
            : reset
              ? defaultValue(field.key, fields, state)
              : (field.effectiveValue ?? field.value),
        cleared: state.clear.includes(field.key),
      };
    });
}

export function updateConnectionForm(settings, state, action) {
  const next = {
    values: { ...state.values },
    clear: [...state.clear],
    reset: [...state.reset],
    editingSecrets: [...state.editingSecrets],
  };
  const key = action.key;
  const fields = fieldMap(settings);
  const cancelEdit = () => {
    delete next.values[key];
    next.editingSecrets = next.editingSecrets.filter((item) => item !== key);
  };
  if (action.type === 'edit_secret') {
    next.editingSecrets = [...new Set([...next.editingSecrets, key])];
    delete next.values[key];
  } else if (action.type === 'cancel_secret') cancelEdit();
  else if (action.type === 'clear') {
    cancelEdit();
    const targets = [key, fallbackKey(key, fields, state)].filter(Boolean);
    next.clear = action.checked
      ? [...new Set([...next.clear, ...targets])]
      : next.clear.filter((item) => !targets.includes(item));
  } else if (action.type === 'change' && groups[key]) {
    const group = groups[key];
    const provider = action.value || group.provider;
    if (provider === providerFor(fields, state, key)) return state;
    const members = [key, ...group.fields, ...group.legacy];
    for (const member of members) delete next.values[member];
    next.clear = next.clear.filter((item) => !members.includes(item));
    next.reset = next.reset.filter((item) => !members.includes(item));
    next.editingSecrets = next.editingSecrets.filter((item) => !members.includes(item));
    if (provider !== storedProvider(fields, key)) {
      next.values[key] = provider;
      next.reset.push(...group.fields);
    }
  } else if (action.type === 'change') {
    const field = fields.get(key);
    if (!field) return state;
    if (field.secret) {
      if (action.value.trim()) next.values[key] = action.value;
      else delete next.values[key];
    } else {
      delete next.values[key];
      const baseline = connectionFormFields(settings, next).find((item) => item.key === key)?.value;
      if (action.value !== baseline) next.values[key] = action.value;
    }
  }
  return next;
}

export function connectionFormPayload(settings, state) {
  const fields = fieldMap(settings);
  const values = Object.fromEntries(
    Object.entries(state.values).filter(([key, value]) => {
      if (state.clear.includes(key)) return false;
      const field = fields.get(key);
      return (
        field &&
        (!field.secret ||
          (!!value.trim() &&
            (!field.configured || state.reset.includes(key) || state.editingSecrets.includes(key))))
      );
    }),
  );
  return {
    values,
    clear: [...new Set([...state.clear, ...state.reset])].filter((key) => !has(values, key)),
  };
}
