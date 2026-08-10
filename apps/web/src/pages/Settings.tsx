import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { AIProviderConfig } from '@smt/shared';
import { Plus, Trash2, Bot, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import NotificationChannels from '@/components/settings/NotificationChannels.js';
import TeamMembers from '@/components/settings/TeamMembers.js';
import AccountSettings from '@/components/settings/AccountSettings.js';
import ApiTokens from '@/components/settings/ApiTokens.js';

interface ProviderForm {
  name: string;
  provider: 'openai' | 'anthropic' | 'openai_compatible';
  apiKey: string;
  baseUrl: string;
  model: string;
}

const emptyForm: ProviderForm = { name: '', provider: 'openai', apiKey: '', baseUrl: '', model: '' };

export default function SettingsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(emptyForm);

  const { data: providers } = useQuery<AIProviderConfig[]>({
    queryKey: ['ai-providers'],
    queryFn: () => api.get('/ai/providers'),
  });

  const createMutation = useMutation({
    mutationFn: (body: ProviderForm) => api.post('/ai/providers', {
      name: body.name,
      provider: body.provider,
      apiKey: body.apiKey || 'no-key',
      baseUrl: body.baseUrl || undefined,
      model: body.model,
      isDefault: false,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai-providers'] }); setShowForm(false); setForm(emptyForm); toast.success('Provider added'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderForm }) => api.patch(`/ai/providers/${id}`, {
      name: body.name,
      provider: body.provider,
      apiKey: body.apiKey ? body.apiKey : undefined,
      baseUrl: body.baseUrl || null,
      model: body.model,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai-providers'] }); closeForm(); toast.success('Provider updated'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/ai/providers/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai-providers'] }); toast.success('Removed'); },
    onError: (err: Error) => toast.error(err.message),
  });

  function openEdit(p: AIProviderConfig) {
    setEditingId(p.id);
    setForm({ name: p.name, provider: p.provider as ProviderForm['provider'], apiKey: '', baseUrl: p.baseUrl ?? '', model: p.model });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editingId) {
      updateMutation.mutate({ id: editingId, body: form });
    } else {
      createMutation.mutate(form);
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-1">Settings</h1>
      <p className="text-muted-foreground text-sm mb-8">Manage AI providers, alerting, and application settings</p>

      {/* AI Providers */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">AI Providers</h2>
          <button onClick={() => { setEditingId(null); setForm(emptyForm); setShowForm(true); }} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Plus size={14} /> Add provider
          </button>
        </div>

        {showForm && (
          <div className="mb-4 rounded-lg border border-border bg-card p-5">
            <h3 className="text-sm font-semibold mb-3">{editingId ? 'Edit provider' : 'New provider'}</h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Name</label>
                  <input type="text" required value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Type</label>
                  <select value={form.provider} onChange={(e) => setForm(p => ({ ...p, provider: e.target.value as ProviderForm['provider'] }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai_compatible">OpenAI-compatible (LM Studio, Ollama…)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <input type="password" value={form.apiKey} onChange={(e) => setForm(p => ({ ...p, apiKey: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" placeholder="sk-…" />
              </div>
              {form.provider === 'openai_compatible' && (
                <div>
                  <label className="block text-sm font-medium mb-1">Base URL</label>
                  <input type="url" value={form.baseUrl} onChange={(e) => setForm(p => ({ ...p, baseUrl: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" placeholder="http://localhost:11434/v1" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-1">Model</label>
                <input type="text" value={form.model} onChange={(e) => setForm(p => ({ ...p, model: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" placeholder="gpt-4o / claude-3-5-sonnet / llama3.2" />
              </div>
              {editingId && (
                <p className="text-xs text-muted-foreground">Leave API Key blank to keep existing key.</p>
              )}
              <div className="flex gap-2">
                <button type="submit" disabled={createMutation.isPending || updateMutation.isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {editingId ? 'Update' : 'Save'}
                </button>
                <button type="button" onClick={closeForm} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">Cancel</button>
              </div>
            </form>
          </div>
        )}

        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {!providers?.length ? (
            <div className="flex flex-col items-center py-12 text-muted-foreground">
              <Bot size={36} className="mb-3 opacity-30" />
              <p className="text-sm">No AI providers configured.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {providers.map((p) => (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <Bot size={16} className="text-muted-foreground" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.provider} · {p.model}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</p>
                  </div>
                  <button onClick={() => openEdit(p)} className="text-muted-foreground hover:text-foreground mr-1" title="Edit">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => { if (confirm('Remove provider?')) deleteMutation.mutate(p.id); }} className="text-red-500 hover:text-red-600" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <NotificationChannels />
      <TeamMembers />
      <AccountSettings />
      <ApiTokens />
    </div>
  );
}
