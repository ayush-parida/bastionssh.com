import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { SSHKey, CreateSSHKeyRequest, GenerateSSHKeyResponse } from '@smt/shared';
import { Plus, Copy, Trash2, Key as KeyIcon, RefreshCw, Upload, FileCheck } from 'lucide-react';
import { toast } from 'sonner';

/** A private key is a few KB; this only catches an obviously wrong file. */
const MAX_PEM_BYTES = 64 * 1024;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export default function KeysPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [mode, setMode] = useState<'import' | 'generate'>('generate');
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyType, setKeyType] = useState<'ed25519' | 'rsa' | 'ecdsa'>('ed25519');
  const [generatedKey, setGeneratedKey] = useState<GenerateSSHKeyResponse | null>(null);
  const [pemFileName, setPemFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: keys, isLoading } = useQuery<SSHKey[]>({
    queryKey: ['ssh-keys'],
    queryFn: () => api.get('/keys'),
  });

  const generateMutation = useMutation({
    mutationFn: (body: { name: string; keyType: string }) => api.post<GenerateSSHKeyResponse>('/keys/generate', body),
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ['ssh-keys'] }); setGeneratedKey(data); toast.success('Key generated'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const importMutation = useMutation({
    mutationFn: (body: CreateSSHKeyRequest) => api.post<SSHKey>('/keys/import', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ssh-keys'] }); setShowForm(false); resetForm(); toast.success('Key imported'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/keys/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ssh-keys'] }); toast.success('Key deleted'); },
    onError: (err: Error) => toast.error(err.message),
  });

  function resetForm() {
    setName('');
    setPublicKey('');
    setPrivateKey('');
    setPemFileName(null);
  }

  /** Load a .pem straight off disk instead of making the user paste it. */
  async function handlePemFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear it so picking the same file again still fires onChange
    e.target.value = '';
    if (!file) return;

    if (file.size > MAX_PEM_BYTES) {
      toast.error('That file is too large to be a private key.');
      return;
    }

    // Trailing newline: some PEM parsers reject a key without one
    const text = `${(await file.text()).trim()}\n`;
    if (!PEM_PRIVATE_KEY.test(text)) {
      toast.error(`${file.name} doesn't look like a private key — expected a PEM block.`);
      return;
    }

    setPrivateKey(text);
    setPemFileName(file.name);
    // A .pem is usually named after the key it holds, so it's a sensible default
    if (!name.trim()) setName(file.name.replace(/\.(pem|key|txt)$/i, ''));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'generate') {
      generateMutation.mutate({ name, type: keyType as "rsa" | "ed25519" | "ecdsa", generate: true } as any);
    } else {
      importMutation.mutate({ name, privateKey } as any);
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">SSH Keys</h1>
          <p className="text-muted-foreground text-sm">Manage authentication keys</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setGeneratedKey(null); }}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={15} /> Add key
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5">
          <div className="flex gap-4 mb-4">
            {(['generate', 'import'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`text-sm font-medium pb-1 border-b-2 transition-colors capitalize ${mode === m ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                {m}
              </button>
            ))}
          </div>

          {generatedKey ? (
            <div className="space-y-3">
              <p className="text-sm text-emerald-500 font-medium">Key generated! Copy the private key now — it won't be shown again.</p>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Public key</p>
                <div className="flex gap-2">
                  <pre className="flex-1 rounded bg-muted p-2 text-xs font-mono overflow-x-auto">{generatedKey.key.publicKey}</pre>
                  <button onClick={() => { navigator.clipboard.writeText(generatedKey.key.publicKey); toast.success('Copied'); }} className="shrink-0 rounded border border-border p-2 hover:bg-muted"><Copy size={14} /></button>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Private key</p>
                <div className="flex gap-2">
                  <pre className="flex-1 rounded bg-muted p-2 text-xs font-mono overflow-x-auto">{generatedKey.privateKeyPem}</pre>
                  <button onClick={() => { navigator.clipboard.writeText(generatedKey.privateKeyPem); toast.success('Copied'); }} className="shrink-0 rounded border border-border p-2 hover:bg-muted"><Copy size={14} /></button>
                </div>
              </div>
              <button onClick={() => { setShowForm(false); setGeneratedKey(null); }} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">Done</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input type="text" required value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              {mode === 'generate' ? (
                <div>
                  <label className="block text-sm font-medium mb-1">Key type</label>
                  <select value={keyType} onChange={(e) => setKeyType(e.target.value as 'ed25519' | 'rsa' | 'ecdsa')} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                    <option value="ed25519">Ed25519 (recommended)</option>
                    <option value="rsa">RSA 4096</option>
                    <option value="ecdsa">ECDSA P-256</option>
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">Public key</label>
                    <textarea rows={3} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-sm font-medium">Private key</label>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <Upload size={13} /> Import .pem file
                      </button>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pem,.key,.txt"
                      onChange={handlePemFile}
                      className="hidden"
                    />
                    <textarea
                      rows={5}
                      required
                      value={privateKey}
                      placeholder="Paste the key here, or import a .pem file"
                      onChange={(e) => { setPrivateKey(e.target.value); setPemFileName(null); }}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    {pemFileName && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <FileCheck size={12} className="text-emerald-500" />
                        Loaded from <span className="font-mono">{pemFileName}</span>
                      </p>
                    )}
                  </div>
                </>
              )}
              <div className="flex gap-2">
                <button type="submit" className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  {mode === 'generate' ? <><RefreshCw size={14} /> Generate</> : <><Plus size={14} /> Import</>}
                </button>
                <button type="button" onClick={() => { setShowForm(false); resetForm(); }} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}

      {isLoading ? <p className="text-muted-foreground">Loading…</p> : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {keys?.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-muted-foreground">
              <KeyIcon size={40} className="mb-3 opacity-30" />
              <p>No SSH keys yet.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  {['Name', 'Type', 'Fingerprint', 'Created', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keys?.map((k) => (
                  <tr key={k.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{k.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{k.type}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{k.fingerprint}</td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => { if (confirm('Delete key?')) deleteMutation.mutate(k.id); }} className="text-red-500 hover:text-red-600">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
