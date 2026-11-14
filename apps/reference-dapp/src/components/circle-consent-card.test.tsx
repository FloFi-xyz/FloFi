// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): FloFi's consent card on /approve says exactly what the
 * EIP-7702 upgrade is, why, what does not change, how long it stays and how many signatures follow (EN/PT), as a labelled and described dialog
 * that takes focus, in the panel's own classes (never a banner). Rendering records, signs and sends nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CircleConsentCard } from './circle-consent-card';
import { LocaleProvider, type Language } from '../i18n/locale';

const render = (upgrade: boolean, language: Language = 'EN') => renderToStaticMarkup(<LocaleProvider initialLanguage={language}>
  <CircleConsentCard offer={{ chainId: 8453, upgrade, maxFee: '420000' }} network="Base" onAnswer={vi.fn()}/></LocaleProvider>);
const text = (html: string) => html.replace(/<[^>]+>/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
const attribute = (html: string, name: string) => new RegExp(`${name}="([^"]+)"`).exec(html)?.[1] ?? null;

describe('owner requirement: FloFi\'s consent card before FloFi Wallet\'s first Circle-paid operation', () => {
  it('says what the upgrade is, why, what does not change, that it stays, and the three signatures; Upgrade and continue / Not now', () => {
    const html = render(true);
    expect(text(html)).toEqual([
      'Upgrade this FloFi Wallet address to pay the network fee in USDC',
      'The upgrade is an EIP-7702 delegation of this FloFi Wallet address on Base to the open-source Simple7702Account contract, so the network fee can be paid in USDC.',
      'Your address, balances and control do not change.',
      'The upgrade stays until you replace it.',
      'Three signatures follow this first time: the upgrade, a USDC permit, then the operation.',
      'Network fee, at most 0.42 USDC — paid from your USDC through Circle',
      'Upgrade and continue', 'Not now',
      'Choosing Not now signs nothing: the step continues through its own review, which pays its network fee in ETH.']);
  });
  it('is a labelled, described dialog that can take focus, with its own two buttons; never a banner', () => {
    const html = render(true);
    expect(html).toMatch(/^<div class="workflow-run-choice circle-consent" role="dialog"/);
    expect(attribute(html, 'tabindex')).toBe('-1');
    const title = attribute(html, 'aria-labelledby')!;
    expect(html).toContain(`<p id="${title}"><strong>Upgrade this FloFi Wallet address to pay the network fee in USDC</strong></p>`);
    const described = attribute(html, 'aria-describedby')!.split(' ');
    expect(described).toHaveLength(4);
    for (const id of described) expect(html, id).toContain(`id="${id}"`);
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(html).toContain('class="approval-actions"');
    expect(html).not.toMatch(/banner|role="alert"/);
  });
  it('reads entirely in Portuguese on a Portuguese screen', () => {
    expect(text(render(true, 'PT'))).toEqual([
      'Atualizar este endereço da FloFi Wallet para pagar a taxa de rede em USDC',
      'A atualização é uma delegação EIP-7702 deste endereço da FloFi Wallet em Base para o contrato de código aberto Simple7702Account, para que a taxa de rede possa ser paga em USDC.',
      'Seu endereço, seus saldos e o seu controle não mudam.',
      'A atualização permanece até que você a substitua.',
      'Seguem três assinaturas desta primeira vez: a atualização, uma permissão de USDC e, depois, a operação.',
      'Taxa de rede, no máximo 0.42 USDC — paga com seu USDC pela Circle',
      'Atualizar e continuar', 'Agora não',
      'Se escolher Agora não, nada é assinado: a etapa segue pela própria revisão, que paga a taxa de rede em ETH.']);
  });
  it('once the address is upgraded it asks about the USDC fee alone: two signatures, no upgrade wording', () => {
    const html = render(false);
    expect(text(html)).toEqual(['Pay this network fee in USDC through Circle',
      'Your ETH on Base does not cover this network fee. FloFi Wallet can pay it from your USDC through Circle instead.',
      'Two signatures follow: a USDC permit, then the operation.', 'Network fee, at most 0.42 USDC — paid from your USDC through Circle',
      'Pay in USDC and continue', 'Not now',
      'Choosing Not now signs nothing: the step continues through its own review, which pays its network fee in ETH.']);
    expect(attribute(html, 'aria-describedby')!.split(' ')).toHaveLength(2);
    expect(html).not.toContain('EIP-7702');
    expect(text(render(false, 'PT'))).toContain('Pagar em USDC e continuar');
  });
});
