// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BUILD-FLOFI-UX-UI-002: the console's identity — the approved FloFi symbol and wordmark (`public/brand`, unmodified), switched by the
 * same `prefers-color-scheme` query as the console palette (`admin.css`). It replaces the legacy `/flofi-logo.png` (the former Gryloo
 * artwork). Server-rendered, no client code.
 */
export function AdminBrand() {
  return <div className="admin-brand">
    <picture className="admin-brand-symbol">
      <source srcSet="/brand/flofi-symbol-dark.svg" media="(prefers-color-scheme: dark)"/>
      <img src="/brand/flofi-symbol-light.svg" alt="" width={370} height={345}/>
    </picture>
    <div>
      <span className="admin-brand-name">
        <picture>
          <source srcSet="/brand/flofi-wordmark-dark.png" media="(prefers-color-scheme: dark)"/>
          <img src="/brand/flofi-wordmark-light.png" alt="FloFi" width={738} height={280}/>
        </picture>
        <span>Admin</span>
      </span>
      <small>Private console</small>
    </div>
  </div>;
}
