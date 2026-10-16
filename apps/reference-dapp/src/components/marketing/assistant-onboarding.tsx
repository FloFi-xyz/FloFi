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
/** The documented connector paths (docs/deploy/MCP.md §2), shortened. Both use FloFi's own OAuth consent page; neither offers in-chat signing. */
export const ASSISTANT_HOSTS = [
  { id: 'claude', name: 'Claude', mark: '/brand/providers/claude-spark.svg', size: 20, open: 'claudeOpen', add: 'claudeAdd' },
  { id: 'chatgpt', name: 'ChatGPT', mark: '/brand/providers/openai-blossom-black.svg', size: 40, open: 'chatgptOpen', add: 'chatgptAdd' },
] as const;
/** The illustration's steps: the request, FloFi working, its answer, then the handoff to the visitor's wallet in FloFi. */
export const ASSISTANT_LAST_STEP = 4;

/**
 * BUILD-FLOFI-UX-UI-002 (UX/UI-005, owner simplification): connect FloFi's MCP server once, then ask. The left column holds only the
 * assistant-specific setup (full instructions live in /docs/mcp-integrations); the right one is a short illustration that ends where
 * the visitor continues in FloFi with their own wallet. It names no tool and claims no install, signature or execution in the chat.
 */
export function AssistantOnboarding({ t }: { t: LandingCopy }) {
  const [selected, setSelected] = useState(0), [copied, setCopied] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const step = useScriptedSteps(chatRef, ASSISTANT_LAST_STEP, selected);
  const host = ASSISTANT_HOSTS[selected]!;
  const shown = (from: number, until = Infinity) => step >= from && step < until ? 'true' : 'false';
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
      <div className={styles.assistantsHeading}>
        <div className={styles.assistantsLead}><p className={styles.kicker}>{t.assistantsEyebrow}</p><h2 id="assistants-title">{t.assistantsTitleFirst} <span>{t.assistantsTitleSecond}</span></h2></div>
        <MascotDock scene="assistants" compact/>
      </div>
      <div className={styles.assistantPanel}>
        <div className={styles.assistantConnect}>
          <h3>{t.assistantsConnect}</h3>
          <div className={styles.assistantTabs} role="tablist" aria-label={t.assistantsChoose}>
            {ASSISTANT_HOSTS.map((item, i) => <button key={item.id} ref={element => { tabs.current[i] = element; }} type="button" role="tab" id={`assistant-tab-${item.id}`}
              aria-selected={i === selected} aria-controls="assistant-panel" tabIndex={i === selected ? 0 : -1} data-host={item.id}
              onClick={() => choose(i)} onKeyDown={onKeyDown}>
              <Image src={item.mark} alt="" width={item.size} height={item.size} unoptimized draggable={false}/>{item.name}
            </button>)}
          </div>
          <div id="assistant-panel" role="tabpanel" aria-labelledby={`assistant-tab-${host.id}`} data-assistant={host.id}>
            <ol>
              <li>{t[host.open]}</li>
              <li>{t[host.add]}<span className={styles.assistantUrl}><code>{FLOFI_MCP_URL}</code>
                <button type="button" onClick={() => void copy()}>{copied ? t.assistantsCopied : t.assistantsCopy}</button></span></li>
            </ol>
            <p className={styles.assistantNote}>{t.assistantsNote}</p>
          </div>
        </div>
        <div ref={chatRef} className={styles.assistantChat} role="group" aria-label={`${t.assistantsIllustration} · ${host.name}`} data-assistant-step={step}>
          <div className={styles.assistantChatHead}>
            <Image src={host.mark} alt="" width={host.size} height={host.size} unoptimized draggable={false} data-host={host.id}/>
            <h3>{t.assistantsUse}</h3><span className={styles.demoBadge}>{t.demoIllustration}</span>
          </div>
          <ol>
            <li className={`${styles.demoUser} ${styles.reveal}`} data-shown={shown(1)}>{t.assistantsPrompt}</li>
            <li className={styles.assistantSlot}>
              <span className={`${styles.demoThinking} ${styles.reveal}`} data-shown={shown(2, 3)} aria-hidden="true"><i/><i/><i/></span>
              <span className={`${styles.assistantReply} ${styles.reveal}`} data-shown={shown(3)}>
                <Image src="/brand/flofi-symbol-light.svg" alt="" width={370} height={345} unoptimized draggable={false}/>{t.assistantsReply}
              </span>
            </li>
            <li className={`${styles.assistantHandoff} ${styles.reveal}`} data-shown={shown(4)}>
              <Image src="/brand/flofi-symbol-dark.svg" alt="" width={370} height={345} unoptimized draggable={false}/>
              <strong>{t.assistantsContinue}</strong><span>{t.assistantsAuthorize}</span>
            </li>
          </ol>
        </div>
      </div>
    </div>
  </section>;
}
