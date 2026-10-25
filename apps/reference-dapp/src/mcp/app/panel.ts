// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP Apps approval wrapper. Authenticated tool metadata stays private to the UI. The wrapper can embed FloFi's existing
 * signing runtime on a fixed, trusted same-origin path, or explicitly open the minimal external signing page. It never signs.
 * Embedded signing requires host framing support and a compatible wallet provider; no vendor acceptance is inferred.
 * Status and verified receipts still come from the app-only progress tool, never from iframe messages.
 */
import { trustedFlofiUrl } from '../../platform/navigation.ts';

export const PANEL_URI = 'ui://flofi/approval-panel-chat-first-v1.html';
export const LEGACY_PANEL_URI = 'ui://flofi/approval-panel.html';
export const PANEL_MIME = 'text/html;profile=mcp-app';
export type PanelSettings = { readonly origin: string; readonly inFrameProbeHosts: readonly string[] };

/**
 * The panel's browser program. It is serialized with `Function.prototype.toString`, so it must stay self-contained: no imports,
 * no closure over module scope, only browser globals. Strings from the server are rendered with `textContent`, never as HTML.
 */
export function panelMain(settings: PanelSettings, trustedUrl: typeof trustedFlofiUrl): void {
  type Json = Record<string, unknown>;
  type Step = { index: number; action: string; network: string; destinationNetwork: string | null; protocol: string; kind: string };
  type Approval = { approvalId: string; approvalUrl?: string; workflowHash: string; expiresAt: string; status: string; networkEnvironment: string; fundsClass: string;
    steps: Step[]; authority: string; requires?: string[]; summary?: string; walletNamespace?: string };
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  type Visual = { tree: Json; width: number; height: number; alt: string };
  const view: { approval: Approval | null; progress: Json | null; error: string | null; host: string; opened: string | null; probe: Json | null; reported: string;
    visual: Visual | null } = { approval: null, progress: null, error: null, host: '', opened: null, probe: null, reported: '', visual: null };
  let nextId = 1, timer: ReturnType<typeof setTimeout> | null = null, polls = 0;
  let opening = false, disposed = false;
  let signingFrame: HTMLIFrameElement | null = null;
  let frameTimeout: ReturnType<typeof setTimeout> | null = null;
  const closeFrame = () => { if (frameTimeout) clearTimeout(frameTimeout); frameTimeout = null; signingFrame?.remove(); signingFrame = null; };
  const post = (message: Json) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const request = (method: string, params: Json) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => { if (pending.delete(id)) reject(new Error('HOST_TIMEOUT')); }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    post({ id, method, params });
  });
  const callTool = async (name: string, args: Json): Promise<Json> => {
    const result = await request('tools/call', { name, arguments: args }) as { structuredContent?: Json; isError?: boolean; _meta?: Json };
    const content = result?.structuredContent ?? {};
    if (result?.isError || content.ok !== true) throw new Error(typeof content.code === 'string' ? content.code : 'TOOL_FAILED');
    const links = result?._meta?.['flofi/approval'];
    return links && typeof links === 'object' ? { ...content, approvalUrl: (links as Json).approvalUrl, walletLinks: (links as Json).walletLinks } : content;
  };
  const el = (tag: string, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (label: string, onClick: () => void, primary = false) => {
    const node = el('button', label, primary ? 'primary' : 'secondary') as HTMLButtonElement;
    node.type = 'button'; node.addEventListener('click', onClick);
    node.disabled = opening;
    return node;
  };
  // The workflow visual: only the style properties the shared layout uses, only plain values (no url(), no var(), no expressions).
  const STYLE_KEYS = new Set(['display', 'flexDirection', 'alignItems', 'justifyContent', 'height', 'width', 'lineHeight', 'fontSize', 'color', 'whiteSpace', 'overflow',
    'textOverflow', 'flexShrink', 'flexGrow', 'minWidth', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'padding', 'backgroundColor', 'border',
    'borderRadius', 'letterSpacing', 'fontFamily']);
  const styleValue = (value: unknown) => {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value : null;
    return text !== null && /^[#a-zA-Z0-9 .,%-]{0,80}$/.test(text) ? text : null;
  };
  const paint = (node: unknown, depth = 0): HTMLElement | null => {
    const n = node as { type?: unknown; props?: { style?: unknown; children?: unknown } } | null;
    if (depth > 12 || !n || n.type !== 'div') return null;
    const out = document.createElement('div');
    for (const [key, value] of Object.entries(n.props?.style && typeof n.props.style === 'object' ? n.props.style as Json : {})) {
      const text = styleValue(value);
      if (STYLE_KEYS.has(key) && text !== null) out.style.setProperty(key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`), text);
    }
    const children = n.props?.children;
    if (typeof children === 'string') out.textContent = children;
    else if (Array.isArray(children)) for (const child of children.slice(0, 400)) { const painted = paint(child, depth + 1); if (painted) out.append(painted); }
    return out;
  };
  const isVisual = (value: unknown): value is Visual => !!value && typeof value === 'object' && typeof (value as Json).alt === 'string'
    && typeof (value as Json).width === 'number' && typeof (value as Json).height === 'number' && !!(value as Json).tree;
  /** The visual in a frame of the panel's width: scaled down (never up), labelled with its text alternative. */
  function figure(visual: Visual, root: HTMLElement) {
    const frame = el('div', undefined, 'visual'), painted = paint(visual.tree);
    if (!painted) return;
    frame.setAttribute('role', 'img'); frame.setAttribute('aria-label', visual.alt);
    painted.setAttribute('aria-hidden', 'true'); painted.style.transformOrigin = 'top left';
    frame.append(painted); root.append(frame);
    const scale = Math.min(1, (frame.clientWidth || visual.width) / visual.width);
    painted.style.transform = `scale(${scale})`;
    frame.style.height = `${Math.ceil(visual.height * scale)}px`;
  }
  const isApproval = (value: unknown): value is Approval => !!value && typeof value === 'object' && typeof (value as Json).approvalId === 'string' &&
    /^apr_[a-z2-7]{26}$/.test(String((value as Json).approvalId)) && Array.isArray((value as Json).steps);
  const terminal = (status: unknown) => ['EXPIRED', 'SUPERSEDED', 'REVOKED', 'STALE'].includes(String(status));
  const approvalLink = (value: unknown, approvalId: string, privateLink: boolean): URL | null => {
    const url = trustedUrl(value, settings.origin);
    return url && url.href === `${settings.origin}/approve${url.hash}` && (privateLink
      ? /^#flofi_hs_[A-Za-z0-9_-]{43}$/.test(url.hash) : url.hash === `#${approvalId}`) ? url : null;
  };
  const receipt = (run: Json): string | null => {
    if (run.reconciled !== true || typeof run.receiptUrl !== 'string' || typeof run.executionId !== 'string') return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run.executionId)) return null;
    const url = trustedUrl(run.receiptUrl, settings.origin);
    return url?.href === `${settings.origin}/app/dashboard/runs/${encodeURIComponent(run.executionId)}` ? url.href : null;
  };

  /** Opens a FloFi URL through the host (MCP Apps `ui/open-link`; ChatGPT's `openExternal` when the standard call is refused). */
  async function openLink(url: string) {
    try { const result = await request('ui/open-link', { url }) as { isError?: boolean } | undefined;
      if (result?.isError) throw new Error('OPEN_LINK_REFUSED'); return; }
    catch {
      const openai = (window as unknown as { openai?: { openExternal?: (input: { href: string; redirectUrl: false }) => unknown } }).openai;
      if (openai?.openExternal) { await openai.openExternal({ href: url, redirectUrl: false }); return; }
      throw new Error('OPEN_LINK_REFUSED');
    }
  }
  async function connect(target: 'chat' | 'window' | 'phantom' | 'metamask') {
    if (!view.approval || opening) return;
    const approvalId = view.approval.approvalId;
    opening = true; view.error = null; render();
    try {
      const session = await callTool('open_approval_session', { approvalId });
      if (disposed || view.approval?.approvalId !== approvalId) return;
      const links = (session.walletLinks ?? {}) as Record<string, string>;
      const url = target === 'window' || target === 'chat' ? String(session.approvalUrl) : links[target];
      const approval = approvalLink(session.approvalUrl, approvalId, true);
      if (!approval || session.approvalId !== approvalId) throw new Error('APPROVAL_LINK_INVALID');
      const expected = target === 'window' || target === 'chat' ? approval.href : target === 'metamask'
        ? `https://metamask.app.link/dapp/${approval.origin.replace(/^https?:\/\//, '')}/approve${approval.hash}`
        : `https://phantom.com/ul/browse/${encodeURIComponent(approval.origin + '/approve')}?ref=${encodeURIComponent(settings.origin)}`;
      if (url !== expected) throw new Error('APPROVAL_LINK_INVALID');
      view.approval.approvalUrl = String(session.approvalUrl);
      if (target === 'chat') {
        // Derive only this fixed same-origin path from the authenticated app-only result, never a model-supplied embed URL.
        closeFrame();
        const frame = document.createElement('iframe');
        frame.title = 'Authorize with your wallet in this chat';
        frame.referrerPolicy = 'no-referrer';
        frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms');
        frame.src = `${approval.origin}/mcp/approve${approval.hash}`;
        frame.className = 'signing-frame';
        frame.hidden = true;
        // The host's sandbox still applies. No popup, top navigation or delegated signing permission is requested.
        document.body.insertBefore(frame, document.getElementById('app')); signingFrame = frame;
        frameTimeout = setTimeout(() => {
          if (signingFrame === frame && frame.hidden) {
            closeFrame(); view.error = 'This host could not load the in-chat signing surface. Nothing was authorized by opening it. Open FloFi is an optional external fallback.'; render();
          }
        }, 15_000);
      } else await openLink(url);
      view.opened = target;
      schedule(2_000);
    } catch (error) { view.error = error instanceof Error ? error.message : 'OPEN_FAILED'; }
    finally { opening = false; }
    render();
  }
  /** Adapter A: report what this frame can do; never request accounts, never sign. */
  function probe() {
    const w = window as unknown as { ethereum?: unknown; solana?: unknown; phantom?: unknown };
    let standardWallets = 0;
    try {
      window.addEventListener('wallet-standard:register-wallet', () => { standardWallets++; }, { once: false });
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: () => { standardWallets++; return () => undefined; } } }));
    } catch { /* events may be blocked */ }
    let popups: string;
    try { const opened = window.open('about:blank', '_blank', 'noopener'); popups = opened === null ? 'BLOCKED_OR_NOOPENER' : 'ALLOWED'; } catch { popups = 'BLOCKED'; }
    view.probe = { host: view.host || 'unknown', injectedEvm: typeof w.ethereum === 'object' && w.ethereum !== null, injectedSolanaLegacy: !!(w.solana || w.phantom),
      walletStandard: standardWallets, popups, origin: location.origin, checkedAt: new Date().toISOString(),
      note: 'Diagnostics only: the signing surface checks its own wallet providers.' };
    render();
  }
  function schedule(delay: number) {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void poll(); }, delay);
  }
  async function poll() {
    if (disposed || !view.approval || polls++ > 360) return;
    const approvalId = view.approval.approvalId;
    try {
      const progress = await callTool('get_execution_progress', { approvalId });
      if (disposed || view.approval?.approvalId !== approvalId) return;
      view.progress = progress;
      view.error = null;
      report();
    } catch (error) { view.error = error instanceof Error ? error.message : 'PROGRESS_FAILED'; }
    render();
    const runs = Array.isArray(view.progress?.runs) ? view.progress!.runs as Json[] : [];
    const done = terminal(view.progress?.status) || runs.length > 0 && runs.every(r => r.reconciled === true || r.terminal === true);
    if (!done) schedule(view.opened ? 5_000 : 15_000);
  }
  /** Status and evidence back to the conversation: public facts only (ids, states, environment, bundle hash). */
  function report() {
    const progress = view.progress;
    if (!progress) return;
    // Explicit projection: even a malformed progress response cannot smuggle a capability/payload into model context.
    const token = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v) && !v.startsWith('flofi_') ? v : null;
    const hash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) ? v : null;
    const runs = (Array.isArray(progress.runs) ? progress.runs as Json[] : []).filter(r => r && typeof r === 'object').map(r => ({
      executionId: token(r.executionId), flow: token(r.flow), status: token(r.status), reconciled: r.reconciled === true,
      terminal: r.terminal === true, evidenceEnvironment: token(r.evidenceEnvironment), evidenceBundleHash: hash(r.evidenceBundleHash), receiptUrl: receipt(r) }));
    const status = token(progress.status);
    const summary = JSON.stringify({ status, runs });
    if (summary === view.reported) return;
    view.reported = summary;
    const lines = [`FloFi approval ${view.approval?.approvalId}: ${String(status)}.`, ...runs.map(r =>
      `Run ${String(r.executionId)} (${String(r.flow)}): ${String(r.status)}${r.evidenceEnvironment ? `, evidence ${String(r.evidenceEnvironment)} ${String(r.evidenceBundleHash ?? '')}` : ''}.${r.receiptUrl ? ` Receipt: ${r.receiptUrl}` : ''}`)];
    void request('ui/update-model-context', { content: [{ type: 'text', text: lines.join(' ') }],
      structuredContent: { flofiApproval: { approvalId: view.approval?.approvalId, status, runs } } }).catch(() => undefined);
  }

  function render() {
    const root = document.getElementById('app')!;
    root.replaceChildren();
    const a = view.approval;
    if (!a) { root.append(el('p', view.error ? `FloFi could not prepare this approval (${view.error}).` : 'Waiting for the FloFi approval…', 'muted')); return; }
    const status = String(view.progress?.status ?? a.status);
    const head = el('div', undefined, 'head');
    head.append(el('span', 'FLOFI · APPROVAL', 'eyebrow'), el('span', status, 'badge'));
    root.append(head);
    if (signingFrame?.hidden) root.append(el('p', 'Opening your wallet review in this chat…', 'notice'));
    if (!signingFrame) root.append(el('h1', a.steps.length === 1 ? `Review ${a.steps[0]!.action}` : 'Review your operation'),
      el('p', 'Nothing is authorized yet. Only your own wallet can sign, after a fresh simulation and the Strategy Manifest Review in FloFi.', 'notice'));
    if (a.fundsClass === 'REAL_FUNDS') root.append(el('p', 'Real funds: this strategy uses a mainnet.', 'warning'));
    if (view.visual && !signingFrame) figure(view.visual, root);
    const facts = el('dl'), technical = el('details');
    technical.append(el('summary', 'Proposal details'));
    const fact = (label: string, value: string) => { facts.append(el('dt', label), el('dd', value)); };
    fact('Network', `${a.networkEnvironment === 'MAINNET' ? 'Mainnet' : 'Public testnet'} · ${[...new Set(a.steps.flatMap(s => [s.network, s.destinationNetwork].filter(Boolean) as string[]))].join(' → ')}`);
    fact('Funds', a.fundsClass === 'REAL_FUNDS' ? 'Real funds' : 'Test funds');
    // The picture shows the steps; the plain list remains for a result without one.
    if (!view.visual) fact('Steps', a.steps.map(s => `${s.index + 1}. ${s.action} (${s.protocol || s.kind})`).join('  '));
    if (!signingFrame) root.append(facts);
    technical.append(el('p', `Workflow hash: ${a.workflowHash}`), el('p', a.authority));
    if (a.summary) technical.append(el('p', a.summary)); if (!signingFrame) root.append(technical);
    const runs = Array.isArray(view.progress?.runs) ? view.progress!.runs as Json[] : [];
    if (runs.length) {
      const list = el('ul', undefined, 'runs');
      for (const r of runs) {
        const row = el('li', `${String(r.flow)} · ${String(r.status)}${r.evidenceEnvironment ? ` · evidence ${String(r.evidenceEnvironment)}` : ''}`), link = receipt(r);
        if (link) row.append(button('View receipt', () => { void openLink(link).catch(() => { view.error = 'OPEN_LINK_REFUSED'; render(); }); }));
        list.append(row);
      }
      root.append(el('h2', 'Execution'), list);
    }
    if (!terminal(status) && status !== 'APPLIED') {
      const actions = el('div', undefined, 'actions');
      if (!signingFrame) actions.append(button('Authorize in chat', () => void connect('chat'), true));
      actions.append(button('Open FloFi', () => void connect('window')));
      root.append(actions);
      const mobile = el('div', undefined, 'actions');
      mobile.append(el('span', 'On your phone:', 'muted'), a.walletNamespace === 'solana'
        ? button('Open Phantom browser', () => void connect('phantom')) : button('Open in MetaMask', () => void connect('metamask')));
      if (!signingFrame) {
        root.append(mobile);
        if (a.walletNamespace === 'solana') root.append(el('p', 'In Phantom, paste the private FloFi approval link below into its browser. Keep this link private.', 'muted'));
        root.append(el('p', 'In-chat authorization needs a wallet that is available in this host. If your wallet is unavailable here, Open FloFi is an optional external fallback; that fallback is not completion inside the chat.', 'muted'));
      }
    }
    if (!signingFrame && a.approvalUrl && !terminal(status)) {
      const fallback = el('p', 'Or open this link in a browser with your wallet: ', 'muted');
      fallback.append(el('code', a.approvalUrl));
      root.append(fallback);
      if (!a.approvalUrl.includes('flofi_')) root.append(el('p', 'Use the same browser you used to connect FloFi to your assistant.', 'muted'));
    }
    if (view.opened && !signingFrame) root.append(el('p', 'Check the fresh simulation and choose Authorize in wallet, then confirm in your wallet. This panel checks the recorded result.', 'muted'));
    if (!signingFrame && settings.inFrameProbeHosts.includes(view.host)) {
      root.append(button('Check this chat environment (diagnostics)', probe));
      if (view.probe) root.append(el('pre', JSON.stringify(view.probe, null, 1)));
    }
    if (view.error) root.append(el('p', view.error, 'error'));
    root.append(button('Refresh status', () => { polls = 0; void poll(); }));
    post({ method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } });
  }

  window.addEventListener('message', event => {
    if (signingFrame && event.source === signingFrame.contentWindow && event.origin === settings.origin
      && event.data?.type === 'flofi/approval-frame' && Number.isFinite(event.data.height)) {
      if (frameTimeout) clearTimeout(frameTimeout); frameTimeout = null;
      signingFrame.hidden = false;
      // Keep wallet dialogs within the visible host viewport; the signing document scrolls for longer financial reviews.
      signingFrame.style.height = `${Math.min(900, Math.max(480, Math.min(window.innerHeight, event.data.height)))}px`;
      post({ method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } });
      return;
    }
    if (event.source !== window.parent) return;
    const message = event.data as Json & { id?: number; method?: string; params?: Json; result?: unknown; error?: { message?: string } };
    if (!message || message.jsonrpc !== '2.0') return;
    if (typeof message.id === 'number' && pending.has(message.id) && !message.method) {
      const waiter = pending.get(message.id)!; pending.delete(message.id);
      clearTimeout(waiter.timeout);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'HOST_ERROR')); else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      const content = (message.params as { structuredContent?: unknown } | undefined)?.structuredContent;
      // A missing/failed result must clear any prior CTA. The host remains responsible for delivering genuine MCP results.
      view.approval = null; view.visual = null; view.progress = null;
      closeFrame();
      if (timer) clearTimeout(timer);
      if (message.params?.isError !== true && (content as Json | undefined)?.ok === true && isApproval(content)) {
        const privateLinks = (message.params?._meta as Json | undefined)?.['flofi/approval'] as Json | undefined;
        const visual = (message.params?._meta as Json | undefined)?.['flofi/visual'];
        const publicUrl = approvalLink(content.approvalUrl, content.approvalId, false);
        const privateUrl = privateLinks ? approvalLink(privateLinks.approvalUrl, content.approvalId, true) : null;
        if (!publicUrl || privateLinks && !privateUrl) view.error = 'APPROVAL_LINK_INVALID';
        else {
          view.approval = { ...content, approvalUrl: privateUrl?.href ?? publicUrl.href };
          view.visual = isVisual(visual) ? visual : null;
          view.error = null; view.reported = ''; polls = 0; schedule(10_000);
        }
      }
      else view.error = typeof (content as Json | undefined)?.code === 'string' ? String((content as Json).code) : 'NO_APPROVAL';
      render();
    } else if (message.method === 'ui/resource-teardown') {
      closeFrame();
      disposed = true; if (timer) clearTimeout(timer);
      for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error('APP_CLOSED')); }
      pending.clear(); if (typeof message.id === 'number') post({ id: message.id, result: {} });
    } else if (message.method === 'ui/notifications/host-context-changed') {
      const theme = (message.params as { theme?: string } | undefined)?.theme;
      if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
    } else if (typeof message.id === 'number' && message.method) {
      post({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  });
  window.addEventListener('resize', () => { if (view.visual) render(); });
  render();
  void request('ui/initialize', { appInfo: { name: 'flofi-approval', version: '1.0.0' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: '2026-01-26' }).then(result => {
    const r = result as { hostInfo?: { name?: string }; hostContext?: { theme?: string } } | undefined;
    view.host = String(r?.hostInfo?.name ?? '');
    if (r?.hostContext?.theme === 'dark' || r?.hostContext?.theme === 'light') document.documentElement.dataset.theme = r.hostContext.theme;
    post({ method: 'ui/notifications/initialized', params: {} });
    render();
  }).catch(() => { view.error = 'HOST_NOT_MCP_APPS'; render(); });
}

const STYLE = `:root{color-scheme:light dark;--bg:#ffffff;--ink:#14233a;--muted:#52627a;--line:#dce4ef;--soft:#f4f7fb;--blue:#1d5fca;--amber:#915e08;--amber-soft:#fff5de;--red:#a11c29}
:root[data-theme=dark]{--bg:#0f141b;--ink:#e8edf4;--muted:#9aa8ba;--line:#2a3442;--soft:#17202b;--blue:#6ea1ff;--amber:#f2c46b;--amber-soft:#2a2110;--red:#ff8a96}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f141b;--ink:#e8edf4;--muted:#9aa8ba;--line:#2a3442;--soft:#17202b;--blue:#6ea1ff;--amber:#f2c46b;--amber-soft:#2a2110;--red:#ff8a96}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}#app{padding:16px;display:grid;gap:10px;max-width:720px}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px}.eyebrow{font-size:10px;font-weight:800;letter-spacing:.14em;color:var(--muted)}
.badge{border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700}h1{font-size:17px;margin:0}h2{font-size:14px;margin:6px 0 0}
.notice{margin:0;padding:8px 10px;background:var(--soft);border-radius:8px}.warning{margin:0;padding:8px 10px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-weight:700}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}dt{color:var(--muted);font-size:12px}dd{margin:0;overflow-wrap:anywhere;font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}button{min-height:40px;border-radius:8px;padding:0 14px;font:inherit;font-weight:700;cursor:pointer}
button.primary{background:var(--blue);color:#fff;border:0}button.secondary{background:var(--soft);color:var(--ink);border:1px solid var(--line)}
.muted{color:var(--muted);font-size:12px;margin:0}code{font-size:11px;overflow-wrap:anywhere}pre{font-size:11px;background:var(--soft);padding:8px;border-radius:8px;overflow:auto}
.error{color:var(--red);margin:0;font-weight:700}.runs{margin:0;padding-left:18px}
.signing-frame{display:block;width:100%;min-height:480px;border:0;background:var(--bg)}.signing-frame[hidden]{display:none}\n.visual{width:100%;max-width:482px;overflow:hidden;border-radius:12px;border:1px solid var(--line)}`;

/** The panel document: one HTML file with inline style and script, no external resource. */
export function panelHtml(settings: PanelSettings): string {
  const frameOrigin = trustedFlofiUrl(`${settings.origin}/`, settings.origin)?.origin ?? "'none'";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="frame-src ${frameOrigin}; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'">` +
    `<title>FloFi approval</title><style>${STYLE}</style></head><body><main id="app" aria-live="polite"></main>` +
    `<script>(${panelMain.toString()})(${JSON.stringify(settings).replace(/</g, '\\u003c')}, ${trustedFlofiUrl.toString()});</script></body></html>`;
}
/** MCP Apps metadata: one same-origin signing frame, no wrapper network or external resources. Existing redirect allowlist is retained. */
export function panelResourceMeta(origin: string) {
  return { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [origin], baseUriDomains: [] }, prefersBorder: true },
    'openai/widgetCSP': { connect_domains: [], resource_domains: [], frame_domains: [origin], redirect_domains: [origin, 'https://phantom.com', 'https://metamask.app.link'] },
    'openai/widgetDescription': 'FloFi approval: opens the existing signing surface inside the conversation when the host and wallet support it. External FloFi is optional. Only the wallet signs.',
    'openai/widgetPrefersBorder': true };
}
