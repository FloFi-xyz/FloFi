// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Image from 'next/image';
import { useRef, useState, type KeyboardEvent } from 'react';
import styles from './landing.module.css';
import type { LandingCopy } from './landing-copy';
import { MascotDock } from './mascot-journey';
import { useScriptedSteps } from './scripted-steps';

/** The deployed FloFi MCP endpoint (its protected-resource metadata names `https://flofi.xyz/api/mcp`; see docs/deploy/MCP.md). */
export const FLOFI_MCP_URL = 'https://flofi.xyz/api/mcp';
/** The documented connector paths (docs/deploy/MCP.md §2). Both use FloFi's own OAuth consent page; neither offers in-chat signing. */
export const ASSISTANT_HOSTS = [
  { id: 'claude', name: 'Claude', mark: '/brand/providers/claude-spark.svg', size: 20, step1: 'claudeStep1', step2: 'claudeStep2' },
  { id: 'chatgpt', name: 'ChatGPT', mark: '/brand/providers/openai-blossom-black.svg', size: 40, step1: 'chatgptStep1', step2: 'chatgptStep2' },
] as const;
/** The MCP tools the illustration names, in the order an assistant uses them (src/mcp/tools.ts). */
export const ILLUSTRATED_TOOLS = ['compose_strategy', 'simulate_strategy', 'request_user_approval'] as const;
export const ASSISTANT_LAST_STEP = 5;

/**
 * BUILD-FLOFI-UX-UI-002 (UX/UI-005): how to connect FloFi's MCP server to Claude or ChatGPT, then a short illustrative conversation using
 * it. The steps follow the operator guide; the conversation names the real tools and stops at the owner's wallet in FloFi.
 */
export function AssistantOnboarding({ t }: { t: LandingCopy }) {
  const [selected, setSelected] = useState(0), [copied, setCopied] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const step = useScriptedSteps(chatRef, ASSISTANT_LAST_STEP, selected);
  const host = ASSISTANT_HOSTS[selected]!;
  const shown = (from: number) => step >= from ? 'true' : 'false';
  const choose = (index: number, focus = false) => { setSelected(index); setCopied(false); if (focus) tabs.current[index]?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = ASSISTANT_HOSTS.length - 1;
    const next = event.key === 'ArrowRight' ? (selected === last ? 0 : selected + 1) : event.key === 'ArrowLeft' ? (selected === 0 ? last : selected - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault(); choose(next, true);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(FLOFI_MCP_URL); setCopied(true); } catch { setCopied(false); }
  };
  return <section id="assistants" className={styles.assistantsSection} aria-labelledby="assistants-title">
    <div className={styles.container}>
      <div className={styles.scenariosHeading}><div><p className={styles.kicker}>{t.assistantsEyebrow}</p><h2 id="assistants-title">{t.assistantsTitle}</h2></div><p>{t.assistantsBody}</p></div>
      <MascotDock scene="assistants"/>
      <div className={styles.assistantTabs} role="tablist" aria-label={t.assistantsChoose}>
        {ASSISTANT_HOSTS.map((item, i) => <button key={item.id} ref={element => { tabs.current[i] = element; }} type="button" role="tab" id={`assistant-tab-${item.id}`}
          aria-selected={i === selected} aria-controls="assistant-panel" tabIndex={i === selected ? 0 : -1} data-host={item.id}
          onClick={() => choose(i)} onKeyDown={onKeyDown}>
          <Image src={item.mark} alt="" width={item.size} height={item.size} unoptimized draggable={false}/>{item.name}
        </button>)}
      </div>
      <div id="assistant-panel" role="tabpanel" aria-labelledby={`assistant-tab-${host.id}`} className={styles.assistantPanel} data-assistant={host.id}>
        <div className={styles.assistantConnect}>
          <h3>{t.assistantsConnect}</h3>
          <ol>
            <li>{t[host.step1]}</li>
            <li>{t[host.step2]}<span className={styles.assistantUrl}><code>{FLOFI_MCP_URL}</code>
              <button type="button" onClick={() => void copy()}>{copied ? t.assistantsCopied : t.assistantsCopy}</button></span></li>
            <li>{t.assistantsStep3}</li>
            <li>{t.assistantsStep4}</li>
          </ol>
          <p className={styles.assistantNote}>{t.assistantsNotOneClick}</p>
        </div>
        <div ref={chatRef} className={styles.assistantChat} role="group" aria-label={`${t.assistantsIllustration} · ${host.name}`} data-assistant-step={step}>
          <div className={styles.assistantChatHead}>
            <Image src={host.mark} alt="" width={host.size} height={host.size} unoptimized draggable={false} data-host={host.id}/>
            <strong>{t.assistantsUse}</strong><span className={styles.demoBadge}>{t.demoIllustration}</span>
          </div>
          <ol>
            <li className={`${styles.demoUser} ${styles.reveal}`} data-shown={shown(1)}>{t.assistantsPrompt}</li>
            <li className={`${styles.assistantTool} ${styles.reveal}`} data-shown={shown(2)}><code>FloFi · {ILLUSTRATED_TOOLS[0]}</code><span>{t.assistantsCompose}</span></li>
            <li className={`${styles.assistantTool} ${styles.reveal}`} data-shown={shown(3)}><code>FloFi · {ILLUSTRATED_TOOLS[1]}</code><span>{t.assistantsPreviewTool}</span></li>
            <li className={`${styles.assistantTool} ${styles.assistantApproval} ${styles.reveal}`} data-shown={shown(4)}>
              <code>FloFi · {ILLUSTRATED_TOOLS[2]}</code><span>{t.assistantsApprovalTool}</span>
              <span className={styles.assistantPanelButton} aria-hidden="true">{t.assistantsPanelButton} ↗</span>
            </li>
            <li className={`${styles.assistantOpen} ${styles.reveal}`} data-shown={shown(5)}>
              <Image src="/brand/flofi-symbol-dark.svg" alt="" width={370} height={345} unoptimized draggable={false}/>
              <span>{t.assistantsOpen}</span><small>{t.assistantsStatus}</small>
            </li>
          </ol>
        </div>
      </div>
      <div className={styles.assistantWhere}>
        <h3>{t.assistantsWhere}</h3>
        <div>
          <div data-where="chat"><strong>{t.assistantsInChat}</strong><ul><li>{t.assistantsWhereCompose}</li><li>{t.assistantsWherePreview}</li><li>{t.assistantsWhereStatus}</li></ul></div>
          <div data-where="flofi"><strong>{t.assistantsInFloFi}</strong><ul><li>{t.assistantsWhereWallet}</li><li>{t.assistantsWhereSimulate}</li><li>{t.assistantsWhereReview}</li><li>{t.assistantsWhereSign}</li></ul></div>
        </div>
      </div>
      <div className={styles.assistantActions}><a className={styles.primaryButton} href="/docs/mcp-integrations">{t.assistantsGuide} <span aria-hidden="true">→</span></a></div>
      <p className={styles.scenariosNote}>{t.assistantsSafety}</p>
    </div>
  </section>;
}
